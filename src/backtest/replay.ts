import type { Candle, WolfeWave } from '../types';
import { detectWolfeWaves } from '../strategies/wolfeDetector';
import { config as appConfig } from '../utils/config';
import type {
  BacktestConfig, BacktestFilters, SimTrade, ReplayEvent,
} from './types';
import {
  openTrade, simulateOpenTrades, closeAllAtEnd,
} from './simulator';
import { passesFilters } from './filters';

// ─── Replay engine ────────────────────────────────────────────────────────────
//
// Iteramos las velas una por una y en cada paso pasamos al detector
// el subconjunto candles[0..i+1]. El detector ya valida que P5 sea el último
// pivot, así que solo dispara cuando se acaba de confirmar.
//
// REGLA CRÍTICA — sin look-ahead:
// `findPivots` requiere `pivotStrength` velas a cada lado para confirmar un
// pivot. Si pasamos candles[0..i+1], el pivot más reciente confirmable está
// en `i - pivotStrength`. Eso significa que cualquier wolfe con P5 = pivot
// recién confirmado dispara automáticamente con el delay correcto, sin que
// necesitemos exponer velas futuras. Aun así, ejecutamos la entrada en la
// vela SIGUIENTE a la detección (i+1) para reflejar que en producción
// `scanner.scan()` corre tras el cierre de la vela.

export interface ReplayCallbacks {
  onEvent?: (ev: ReplayEvent) => void;
  onProgress?: (currentIdx: number, totalCandles: number) => void;
  /** Cada cuántas velas reportar progreso. Default 500. */
  progressEvery?: number;
}

export interface ReplayState {
  trades:        SimTrade[];
  openTrades:    SimTrade[];
  equity:        number;            // capital corriente
  peakEquity:    number;            // para drawdown
  wavesDetected: number;
  wavesFiltered: number;

  // Memoria de wolfes recientes para dedup intra-replay
  // (evita re-detectar la misma onda en velas consecutivas)
  lastWaveSignature:   string | null;
  lastWaveAtIdx:       number;
  recentP5Signatures:  Set<string>;
}

/**
 * Corre el replay completo sobre la serie de velas y devuelve el estado final.
 * `candles` debe estar ordenado ascendentemente por timestamp.
 */
export async function runReplay(
  candles: Candle[],
  config: BacktestConfig,
  cbs: ReplayCallbacks = {},
): Promise<ReplayState> {
  if (candles.length === 0) {
    throw new Error('runReplay: candles vacío');
  }

  const state: ReplayState = {
    trades:           [],
    openTrades:       [],
    equity:           config.initialCapital,
    peakEquity:       config.initialCapital,
    wavesDetected:    0,
    wavesFiltered:    0,
    lastWaveSignature:  null,
    lastWaveAtIdx:      -999,
    recentP5Signatures: new Set<string>(),
  };

  const progressEvery = cbs.progressEvery ?? 500;
  const total = candles.length;
  let nextTradeId = 1;

  for (let i = config.warmupCandles; i < total; i++) {
    // Slice "visible" — todo lo que el detector puede mirar
    const visible = candles.slice(0, i + 1);

    // 1. Actualizar trades abiertos con esta vela
    const closed = simulateOpenTrades(
      state.openTrades, visible, i, config, candles,
    );
    for (const c of closed) {
      state.trades.push(c);
      state.equity += c.netPnl ?? 0;
      state.peakEquity = Math.max(state.peakEquity, state.equity);
      cbs.onEvent?.({ type: 'trade_closed', candleIdx: i, trade: c });
    }
    state.openTrades = state.openTrades.filter(
      (t) => !closed.find((c) => c.id === t.id),
    );

    // 2. Buscar nuevas wolfes (solo si capital lo permite)
    if (state.equity < config.minOrderUsd * 1.5) {
      // Capital insuficiente — saltamos detección pero seguimos cerrando
      if ((i - config.warmupCandles) % progressEvery === 0) cbs.onProgress?.(i, total);
      continue;
    }

    const waves = detectWolfeWaves(visible, config.symbol, config.timeframe);

    for (const wave of waves) {
      // Solo bullish si la config lo pide
      if (config.onlyBullish && wave.direction !== 'bullish') continue;

      // ── Filtro de deriva P5 — réplica del scanner de producción ────────────
      // Si el precio actual ya se alejó demasiado de P5 la entrada óptima pasó.
      // Sin esto el backtest abre trades donde TP queda por debajo del entry.
      const latestClose = visible[i].close;
      const driftPct    = Math.abs(latestClose - wave.p5.price) / wave.p5.price;
      const maxDrift    = maxP5DriftPctForTimeframe(wave.timeframe);
      if (driftPct > maxDrift) {
        state.wavesDetected++;
        state.wavesFiltered++;
        cbs.onEvent?.({
          type: 'wave_filtered',
          candleIdx: i,
          wave,
          filterReason: `drift ${(driftPct * 100).toFixed(2)}% > max ${(maxDrift * 100).toFixed(2)}%`,
        });
        continue;
      }

      // Dedup intra-replay: misma firma en menos de 5 velas → skip
      const sig = waveSignature(wave);
      if (sig === state.lastWaveSignature && i - state.lastWaveAtIdx < 5) {
        continue;
      }

      // Dedup adicional: misma P5 (timestamp) ya operada hace poco
      const p5Sig = `${wave.direction}|${wave.p5.timestamp}`;
      if (state.recentP5Signatures.has(p5Sig)) {
        continue;
      }
      state.recentP5Signatures.add(p5Sig);
      // Cap del Set para no crecer infinitamente
      if (state.recentP5Signatures.size > 200) {
        const it = state.recentP5Signatures.values();
        for (let k = 0; k < 100; k++) state.recentP5Signatures.delete(it.next().value!);
      }

      state.wavesDetected++;
      cbs.onEvent?.({ type: 'wave_detected', candleIdx: i, wave });

      // Aplicar filtros del backtest (volumen, EMA50, shape, etc.)
      const filterResult = passesFilters(wave, visible, config.filters);
      if (!filterResult.ok) {
        state.wavesFiltered++;
        cbs.onEvent?.({
          type:        'wave_filtered',
          candleIdx:   i,
          wave,
          filterReason: filterResult.reason,
        });
        continue;
      }

      // Abrir trade — la entrada se ejecuta según entryMode
      const trade = openTrade(
        wave, i, candles, config, state.equity, nextTradeId++,
      );
      if (!trade) continue;

      state.openTrades.push(trade);
      state.lastWaveSignature = sig;
      state.lastWaveAtIdx     = i;
      cbs.onEvent?.({ type: 'trade_opened', candleIdx: i, trade });
    }

    if ((i - config.warmupCandles) % progressEvery === 0) {
      cbs.onProgress?.(i, total);
    }
  }

  // Cerrar trades aún abiertos al final del replay (mark-to-market al close final)
  const closeoutTrades = closeAllAtEnd(state.openTrades, candles, config);
  for (const c of closeoutTrades) {
    state.trades.push(c);
    state.equity += c.netPnl ?? 0;
  }
  state.openTrades = [];

  // Garantizar que applyConfigOverrides no haya dejado el detector en estado raro
  // (no hacemos overrides globales en este path, pero por si el caller los hizo).
  void appConfig;

  return state;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Firma de una wolfe: redondea precios para identificar la misma figura
 * detectada en velas consecutivas (puede pasar si el pivot se re-confirma).
 */
function waveSignature(wave: WolfeWave): string {
  const r = (n: number) => n.toFixed(8);
  return [
    wave.direction,
    r(wave.p1.price), r(wave.p2.price),
    r(wave.p3.price), r(wave.p4.price), r(wave.p5.price),
  ].join('|');
}

/**
 * Misma tabla que `Scanner.maxP5DriftPct()` en producción.
 * Mantener sincronizado con `src/services/scanner.ts`.
 */
function maxP5DriftPctForTimeframe(tf: string): number {
  const map: Record<string, number> = {
    '1min':  0.004,  '3min':  0.005,  '5min':  0.006,
    '15min': 0.010,  '30min': 0.015,  '1hour': 0.020,
    '2hour': 0.025,  '4hour': 0.030,  '6hour': 0.035,
    '12hour':0.040,  '1day':  0.050,
  };
  return map[tf] ?? 0.015;
}

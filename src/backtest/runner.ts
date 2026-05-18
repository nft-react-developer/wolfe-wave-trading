import type { BacktestConfig, BacktestResult } from './types';
import { loadCandles } from './dataLoader';
import { runReplay } from './replay';
import { computeMetrics } from './metrics';
import { logger } from '../utils/logger';

// ─── runBacktest ──────────────────────────────────────────────────────────────
// Orquesta una corrida completa: carga de datos → replay → métricas → resultado.

export async function runBacktest(cfg: BacktestConfig): Promise<BacktestResult> {
  logger.info('Backtest: cargando velas', {
    symbol: cfg.symbol, timeframe: cfg.timeframe,
    from: cfg.startTs ? new Date(cfg.startTs).toISOString() : 'inicio cache',
    to:   cfg.endTs   ? new Date(cfg.endTs).toISOString()   : 'ahora',
  });

  const candles = await loadCandles(cfg.symbol, cfg.timeframe, cfg.startTs, cfg.endTs);
  if (candles.length === 0) {
    throw new Error(`No se obtuvieron velas para ${cfg.symbol} ${cfg.timeframe}`);
  }

  logger.info(`Backtest: ${candles.length} velas cargadas — corriendo replay…`);

  const t0 = Date.now();
  const state = await runReplay(candles, cfg, {
    onProgress: (idx, total) => {
      const pct = ((idx / total) * 100).toFixed(1);
      logger.debug(`Replay progress: ${pct}% (${idx}/${total})`);
    },
  });
  const elapsedMs = Date.now() - t0;

  const fromTs = candles[0].timestamp;
  const toTs   = candles[candles.length - 1].timestamp;

  const metrics = computeMetrics(state.trades, cfg, fromTs, toTs);

  logger.info('Backtest completado', {
    elapsedMs,
    wavesDetected:  state.wavesDetected,
    wavesFiltered:  state.wavesFiltered,
    trades:         state.trades.length,
    finalEquity:    metrics.finalEquity.toFixed(2),
    totalReturnPct: metrics.totalReturnPct.toFixed(2) + '%',
    sortino:        metrics.sortino.toFixed(2),
    maxDdPct:       metrics.maxDrawdownPct.toFixed(2) + '%',
  });

  const result: BacktestResult = {
    config:        cfg,
    symbol:        cfg.symbol,
    timeframe:     cfg.timeframe,
    candleCount:   candles.length,
    fromTs,
    toTs,
    trades:        state.trades,
    wavesDetected: state.wavesDetected,
    wavesFiltered: state.wavesFiltered,
    metrics,
  };

  return result;
}

// ─── Helper para crear config con defaults sensatos ───────────────────────────

export function defaultConfig(
  symbol:    string,
  timeframe: string,
  overrides: Partial<BacktestConfig> = {},
): BacktestConfig {
  return {
    symbol,
    timeframe,

    initialCapital:     overrides.initialCapital     ?? 10_000,
    riskPerTradePct:    overrides.riskPerTradePct    ?? 0.01,
    maxTradeUsd:        overrides.maxTradeUsd        ?? 200,
    minOrderUsd:        overrides.minOrderUsd        ?? 30,

    feePctPerSide:      overrides.feePctPerSide      ?? 0.002,
    slippagePct:        overrides.slippagePct        ?? 0.0005,
    spreadPct:          overrides.spreadPct          ?? 0.0005,

    ambiguousCandleSlFirst: overrides.ambiguousCandleSlFirst ?? true,
    entryMode:          overrides.entryMode          ?? 'market_at_p5',
    entryConfirmWindowCandles: overrides.entryConfirmWindowCandles ?? 3,

    onlyBullish:        overrides.onlyBullish        ?? true,
    warmupCandles:      overrides.warmupCandles      ?? 100,

    filters: {
      // Por defecto: solo el filtro que YA hace el detector (RR sobre TP2).
      // Los demás están "off" para que el primer run sea el benchmark del
      // sistema actual.
      minP5VolumeRatio:     undefined,
      volumeExitRatio:      undefined,
      volumeWindow:         20,
      ema50DeadlineCandles: undefined,
      minShapeScore:        undefined,
      minRrRatio:           undefined,
      reentryEnabled:       false,
      useCloseBasedSL:      false,
      ...overrides.filters,
    },

    startTs: overrides.startTs,
    endTs:   overrides.endTs,
    candlesPath: overrides.candlesPath,
  };
}

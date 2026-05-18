#!/usr/bin/env tsx
import type { Candle } from '../types';
import { runReplay } from './replay';
import { computeMetrics } from './metrics';
import { writeReport } from './report';
import { defaultConfig } from './runner';

// ─── Smoke test ───────────────────────────────────────────────────────────────
//
// Genera una serie sintética con varias "M" bullish encadenadas y corre el
// backtest end-to-end. Sirve para verificar que el pipeline completo
// (detector → replay → simulator → metrics → report) compila y produce
// outputs sensatos sin depender de la red.
//
// Uso:
//   tsx src/backtest/smokeTest.ts

interface Synth {
  candles: Candle[];
  description: string;
}

// Construye una secuencia "M" bullish con 5 puntos visibles + ruido controlado
function buildBullishWolfeSegment(
  startTs:    number,
  startPrice: number,
  tfMs:       number,
  scale:      number,        // amplitud del movimiento
  noisePct:   number,
): Candle[] {
  const out: Candle[] = [];
  let ts = startTs;
  let lastClose = startPrice;

  // Plan de precios objetivo (cierres) describiendo P1→P2→P3→P4→P5→reacción.
  // Movimientos graduales (~0.5-1% por vela) para que pasen el filtro de drift
  // que producción aplica (2% max para 1hour).
  const plan: Array<{ steps: number; target: number; label: string }> = [
    { steps: 8,  target: startPrice * (1 + scale * 1.0),  label: 'up_to_P2' },
    { steps: 8,  target: startPrice * (1 + scale * 0.3),  label: 'down_to_P3' },
    { steps: 8,  target: startPrice * (1 + scale * 0.7),  label: 'up_to_P4' },
    { steps: 10, target: startPrice * (1 - scale * 0.1),  label: 'down_to_P5' },
    // Rebote post-P5 — primer movimiento pequeño (dentro del drift máximo)
    { steps: 12, target: startPrice * (1 + scale * 0.5),  label: 'rebound_to_TP1' },
    { steps: 16, target: startPrice * (1 + scale * 1.1),  label: 'continue_to_TP2' },
  ];

  for (const seg of plan) {
    const slope = (seg.target - lastClose) / seg.steps;
    for (let i = 0; i < seg.steps; i++) {
      const close = lastClose + slope;
      // Ruido pequeño y simétrico para que las velas no sean rectas
      const range = Math.max(close * noisePct, scale * 0.05);
      const open  = lastClose + (Math.random() - 0.5) * range * 0.3;
      const high  = Math.max(open, close) + Math.random() * range * 0.5;
      const low   = Math.min(open, close) - Math.random() * range * 0.5;
      // Volumen: pico en la zona de P5 (segmento "down_to_P5"), bajo después.
      const baseVol = 1000;
      const vol = seg.label === 'down_to_P5'
        ? baseVol * (1.5 + Math.random() * 0.5)
        : seg.label.startsWith('rebound') || seg.label.startsWith('continue')
        ? baseVol * (0.7 + Math.random() * 0.3)
        : baseVol * (0.9 + Math.random() * 0.3);

      out.push({ timestamp: ts, open, high, low, close, volume: vol });
      ts += tfMs;
      lastClose = close;
    }
  }
  return out;
}

function buildSyntheticSeries(): Synth {
  const tfMs = 60 * 60 * 1000;     // 1 hora
  const startTs = Date.UTC(2025, 0, 1, 0, 0, 0);   // 2025-01-01
  const all: Candle[] = [];

  // 1. Padding inicial: 120 velas planas con ruido (warmup + suficiente
  //    historial para EMA50 y MACD).
  let ts = startTs;
  let p = 100;
  for (let i = 0; i < 120; i++) {
    const close = p + (Math.random() - 0.5) * 1.5;
    const open  = p + (Math.random() - 0.5) * 1.5;
    const high  = Math.max(open, close) + Math.random();
    const low   = Math.min(open, close) - Math.random();
    all.push({ timestamp: ts, open, high, low, close, volume: 800 + Math.random() * 200 });
    p = close;
    ts += tfMs;
  }

  // 2. Tres segmentos bullish encadenados (que avanzan el precio)
  for (let k = 0; k < 3; k++) {
    const seg = buildBullishWolfeSegment(ts, p, tfMs, 0.08, 0.005);
    all.push(...seg);
    const last = seg[seg.length - 1];
    ts = last.timestamp + tfMs;
    p  = last.close;

    // Plano entre segmentos
    for (let i = 0; i < 10; i++) {
      const close = p + (Math.random() - 0.5) * 0.5;
      all.push({
        timestamp: ts, open: p, high: Math.max(p, close) + 0.2,
        low: Math.min(p, close) - 0.2, close, volume: 800,
      });
      p = close;
      ts += tfMs;
    }
  }

  return {
    candles: all,
    description: `${all.length} velas sintéticas, 1H, 3 segmentos bullish encadenados`,
  };
}

async function main(): Promise<void> {
  /* eslint-disable no-console */
  console.log('=== SMOKE TEST: pipeline end-to-end con datos sintéticos ===\n');

  const synth = buildSyntheticSeries();
  console.log(synth.description);
  console.log(`Rango: ${new Date(synth.candles[0].timestamp).toISOString().slice(0, 10)} → ${new Date(synth.candles[synth.candles.length - 1].timestamp).toISOString().slice(0, 10)}`);

  // Config básica — sin filtros nuevos para que el detector haga su trabajo puro
  const cfg = defaultConfig('SYNTH_BULLISH', '1hour', {
    initialCapital: 10_000,
    warmupCandles:  60,
    onlyBullish:    true,
  });

  console.log('\nCorriendo replay…');
  const t0 = Date.now();
  const state = await runReplay(synth.candles, cfg, {
    progressEvery: 200,
    onProgress: (i, n) =>
      console.log(`  ${((i / n) * 100).toFixed(0)}%  (${i}/${n})`),
  });
  const ms = Date.now() - t0;

  console.log(`Replay completo en ${ms}ms\n`);

  const fromTs = synth.candles[0].timestamp;
  const toTs   = synth.candles[synth.candles.length - 1].timestamp;
  const metrics = computeMetrics(state.trades, cfg, fromTs, toTs);

  console.log('=== Resultado ===');
  console.log(`Wolfes detectadas: ${state.wavesDetected}`);
  console.log(`Wolfes filtradas:  ${state.wavesFiltered}`);
  console.log(`Trades:            ${state.trades.length}`);
  console.log(`Win rate:          ${(metrics.winRate * 100).toFixed(1)}%`);
  console.log(`Total PnL:         ${metrics.totalReturnPct.toFixed(2)}%`);
  console.log(`Final equity:      $${metrics.finalEquity.toFixed(2)}`);
  console.log(`Max DD:            ${metrics.maxDrawdownPct.toFixed(2)}%`);
  console.log(`Profit factor:     ${metrics.profitFactor === Infinity ? '∞' : metrics.profitFactor.toFixed(2)}`);

  // Generar reporte para verificar que writeReport funciona
  const result = {
    config: cfg,
    symbol: 'SYNTH_BULLISH',
    timeframe: '1hour',
    candleCount: synth.candles.length,
    fromTs,
    toTs,
    trades: state.trades,
    wavesDetected: state.wavesDetected,
    wavesFiltered: state.wavesFiltered,
    metrics,
  };

  const { mdPath, csvPath } = writeReport(result, 'smoke_test');
  console.log(`\nReporte: ${mdPath}`);
  console.log(`CSV:     ${csvPath}`);

  // Sanity checks
  let failed = false;
  if (state.wavesDetected === 0) {
    console.error('FAIL: no se detectaron wolfes en una serie diseñada para producirlas');
    failed = true;
  }
  if (!isFinite(metrics.sortino)) {
    console.error('FAIL: sortino no es finito');
    failed = true;
  }
  if (failed) {
    process.exit(2);
  }

  console.log('\n✓ Pipeline end-to-end OK');
  /* eslint-enable no-console */
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Smoke test fallo:', err);
  process.exit(1);
});

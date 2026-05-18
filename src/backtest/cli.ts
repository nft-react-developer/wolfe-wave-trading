#!/usr/bin/env tsx
import { runBacktest, defaultConfig } from './runner';
import { writeReport } from './report';
import { logger } from '../utils/logger';
import type { BacktestConfig } from './types';

// ─── CLI ──────────────────────────────────────────────────────────────────────
//
// Uso:
//   tsx src/backtest/cli.ts --symbol BTCUSDT --timeframe 1hour
//   tsx src/backtest/cli.ts --symbol ETHUSDT --timeframe 4hour --from 2024-01-01 --to 2025-12-31
//   tsx src/backtest/cli.ts --symbol BTCUSDT --timeframe 1hour --vol-min 1.1 --vol-exit 1.2
//
// Flags soportadas (todas opcionales):
//   --symbol       <STR>         (default BTCUSDT)
//   --timeframe    <STR>         (default 1hour)
//   --from         <YYYY-MM-DD>  inicio del replay
//   --to           <YYYY-MM-DD>  fin del replay
//   --capital      <NUM>         capital inicial (default 10000)
//   --risk-pct     <NUM>         % de capital al riesgo por trade (default 0.01)
//   --max-trade    <NUM>         monto USD máximo por trade (default 200)
//   --fee          <NUM>         fee por lado (default 0.002)
//   --slippage     <NUM>         slippage en market (default 0.0005)
//   --spread       <NUM>         spread efectivo (default 0.0005)
//   --entry-mode   <STR>         market_at_p5 | confirm_candle | limit_at_p5
//   --only-bullish <BOOL>        true|false (default true)
//   --vol-min      <NUM>         min volume ratio en P5 (filtro)
//   --vol-exit     <NUM>         exit ratio post-P5
//   --ema-deadline <NUM>         velas máximas sin romper EMA50
//   --shape-min    <NUM>         score mínimo de shape
//   --rr-min       <NUM>         RR mínimo sobre TP2
//   --close-sl                   usar cierre de vela para SL (no mecha)
//   --run-id       <STR>         identificador del run (folder de reporte)

function parseArgs(): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  return args;
}

function asNumber(v: string | boolean | undefined, fallback: number): number {
  if (typeof v === 'string') {
    const n = Number(v);
    return isNaN(n) ? fallback : n;
  }
  return fallback;
}

function asBool(v: string | boolean | undefined, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v === 'true' || v === '1';
  return fallback;
}

function asDate(v: string | boolean | undefined): number | undefined {
  if (typeof v !== 'string') return undefined;
  const t = Date.parse(v);
  return isNaN(t) ? undefined : t;
}

async function main(): Promise<void> {
  const args = parseArgs();

  const symbol    = (args.symbol    as string) ?? 'BTCUSDT';
  const timeframe = (args.timeframe as string) ?? '1hour';

  const cfg: BacktestConfig = defaultConfig(symbol, timeframe, {
    initialCapital:  asNumber(args.capital,    10_000),
    riskPerTradePct: asNumber(args['risk-pct'], 0.01),
    maxTradeUsd:     asNumber(args['max-trade'], 200),
    feePctPerSide:   asNumber(args.fee,        0.002),
    slippagePct:     asNumber(args.slippage,   0.0005),
    spreadPct:       asNumber(args.spread,     0.0005),
    entryMode:       ((args['entry-mode'] as string) ?? 'market_at_p5') as BacktestConfig['entryMode'],
    onlyBullish:     asBool(args['only-bullish'], true),
    startTs:         asDate(args.from),
    endTs:           asDate(args.to),
    filters: {
      minP5VolumeRatio:     args['vol-min']      ? asNumber(args['vol-min'],   1.1) : undefined,
      volumeExitRatio:      args['vol-exit']     ? asNumber(args['vol-exit'],  1.2) : undefined,
      ema50DeadlineCandles: args['ema-deadline'] ? asNumber(args['ema-deadline'], 5) : undefined,
      minShapeScore:        args['shape-min']    ? asNumber(args['shape-min'], 12)  : undefined,
      minRrRatio:           args['rr-min']       ? asNumber(args['rr-min'],    2)   : undefined,
      useCloseBasedSL:      asBool(args['close-sl'], false),
      volumeWindow:         20,
    },
  });

  logger.info('=== BACKTEST CONFIG ===');
  logger.info(JSON.stringify(cfg, null, 2));

  const result = await runBacktest(cfg);

  const runId = (args['run-id'] as string)
    ?? `${symbol}_${timeframe}_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;

  const { mdPath, csvPath } = writeReport(result, runId);

  logger.info(`=== REPORTE GUARDADO ===`);
  logger.info(`MD:  ${mdPath}`);
  logger.info(`CSV: ${csvPath}`);

  // Resumen también a stdout
  const m = result.metrics;
  /* eslint-disable no-console */
  console.log('\n=== RESUMEN ===');
  console.log(`Trades:         ${m.totalTrades} (${m.closedTrades} cerrados)`);
  console.log(`Win rate:       ${(m.winRate * 100).toFixed(1)}%`);
  console.log(`Total return:   ${m.totalReturnPct.toFixed(2)}%`);
  console.log(`CAGR:           ${m.cagr.toFixed(2)}%`);
  console.log(`Max DD:         ${m.maxDrawdownPct.toFixed(2)}%`);
  console.log(`Sortino:        ${m.sortino.toFixed(2)}`);
  console.log(`Sharpe:         ${m.sharpe.toFixed(2)}`);
  console.log(`Calmar:         ${m.calmar.toFixed(2)}`);
  console.log(`Profit factor:  ${m.profitFactor === Infinity ? '∞' : m.profitFactor.toFixed(2)}`);
  console.log(`Expectancy:     ${m.expectancy.toFixed(3)}R (${m.expectancyUsd.toFixed(2)} USD)`);
  console.log(`Wolfes detectadas: ${result.wavesDetected}`);
  console.log(`Wolfes filtradas:  ${result.wavesFiltered}`);
  /* eslint-enable no-console */
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Backtest fallo:', err);
  process.exit(1);
});

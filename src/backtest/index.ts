// ─── Backtest module — public API ────────────────────────────────────────────
//
// Punto de entrada de la librería de backtest. Re-exporta lo necesario para
// usar el backtester desde el CLI o desde otros scripts (walk-forward, etc.).

export * from './types';
export { loadCandles, cachePath, tfToMs } from './dataLoader';
export { runReplay } from './replay';
export type { ReplayCallbacks, ReplayState } from './replay';
export { openTrade, simulateOpenTrades, closeAllAtEnd } from './simulator';
export { passesFilters, computeP5VolumeRatio, postP5VolumeRatio } from './filters';
export { computeMetrics, buildEquityCurve } from './metrics';
export { writeReport } from './report';
export { runBacktest } from './runner';

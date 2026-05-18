import type { BacktestConfig, BacktestMetrics, SimTrade, ShapeBucket } from './types';

// ─── Métricas / KPIs ──────────────────────────────────────────────────────────
//
// Convención: todas las métricas se calculan sobre trades CERRADOS.
// Sortino prioriza desviación a la baja; Sharpe usa desviación total.
// Calmar = CAGR / MaxDrawdown.

export function computeMetrics(
  trades: SimTrade[],
  cfg:    BacktestConfig,
  fromTs: number,
  toTs:   number,
): BacktestMetrics {
  const closed = trades.filter((t) => t.exitIdx !== undefined);

  const totalTrades   = trades.length;
  const closedTrades  = closed.length;
  const wins          = closed.filter((t) => (t.netPnl ?? 0) > 0);
  const losses        = closed.filter((t) => (t.netPnl ?? 0) <= 0);
  const winRate       = closedTrades > 0 ? wins.length / closedTrades : 0;

  const totalPnl      = closed.reduce((s, t) => s + (t.netPnl ?? 0), 0);
  const grossWins     = wins.reduce((s, t)   => s + (t.netPnl ?? 0), 0);
  const grossLosses   = -losses.reduce((s, t) => s + (t.netPnl ?? 0), 0);
  const profitFactor  = grossLosses > 0 ? grossWins / grossLosses : Infinity;

  const totalReturnPct = (totalPnl / cfg.initialCapital) * 100;
  const finalEquity    = cfg.initialCapital + totalPnl;

  // ── Drawdown sobre curva de equity ──────────────────────────────────────────
  const equityCurve = buildEquityCurve(closed, cfg.initialCapital);
  let peak = cfg.initialCapital;
  let maxDdAbs = 0;
  let maxDdPct = 0;
  for (const eq of equityCurve) {
    if (eq.equity > peak) peak = eq.equity;
    const dd = peak - eq.equity;
    if (dd > maxDdAbs) {
      maxDdAbs = dd;
      maxDdPct = (dd / peak) * 100;
    }
  }

  // ── Métricas anualizadas ────────────────────────────────────────────────────
  const yearMs = 365 * 24 * 60 * 60 * 1000;
  const years  = Math.max((toTs - fromTs) / yearMs, 1 / 365);  // mínimo 1 día
  const cagr   = (Math.pow(finalEquity / cfg.initialCapital, 1 / years) - 1) * 100;

  // Returns por trade (en %)
  const tradeReturns = closed.map((t) =>
    (t.netPnl ?? 0) / cfg.initialCapital * 100,
  );
  const mean = avg(tradeReturns);
  const std  = stddev(tradeReturns, mean);
  const downside = stddev(
    tradeReturns.filter((r) => r < 0),
    0,
  );

  // Anualización: trades por año
  const tradesPerYear = closedTrades / years;
  const sharpe  = std      > 0 ? (mean / std)      * Math.sqrt(tradesPerYear) : 0;
  const sortino = downside > 0 ? (mean / downside) * Math.sqrt(tradesPerYear) : 0;
  const calmar  = maxDdPct > 0 ? cagr / maxDdPct : 0;

  // ── Expectancy ──────────────────────────────────────────────────────────────
  const rs = closed.map((t) => t.rMultiple ?? 0);
  const expectancy = avg(rs);
  const expectancyUsd = avg(closed.map((t) => t.netPnl ?? 0));
  const winRs  = wins.map((t)   => t.rMultiple ?? 0);
  const lossRs = losses.map((t) => t.rMultiple ?? 0);
  const avgWinR  = avg(winRs);
  const avgLossR = avg(lossRs);
  const avgRrRealized = avgLossR < 0 ? avgWinR / Math.abs(avgLossR) : 0;

  // ── Por forma ───────────────────────────────────────────────────────────────
  const byShape: Record<string, ShapeBucket> = {};
  for (const shape of ['perfect', 'fat_mw', 'long_neck', 'imperfect'] as const) {
    const bucket = closed.filter((t) => t.shape === shape);
    if (bucket.length === 0) continue;
    byShape[shape] = {
      trades:    bucket.length,
      winRate:   bucket.filter((t) => (t.netPnl ?? 0) > 0).length / bucket.length,
      avgR:      avg(bucket.map((t) => t.rMultiple ?? 0)),
      totalPnl:  bucket.reduce((s, t) => s + (t.netPnl ?? 0), 0),
    };
  }

  // ── Por close reason ────────────────────────────────────────────────────────
  const byCloseReason: Record<string, number> = {};
  for (const t of closed) {
    const r = t.closeReason ?? 'unknown';
    byCloseReason[r] = (byCloseReason[r] ?? 0) + 1;
  }

  // ── Por mes ─────────────────────────────────────────────────────────────────
  const byMonthMap = new Map<string, { pnl: number; trades: number }>();
  for (const t of closed) {
    const d = new Date(t.exitTime ?? t.entryTime);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const cur = byMonthMap.get(key) ?? { pnl: 0, trades: 0 };
    cur.pnl    += t.netPnl ?? 0;
    cur.trades += 1;
    byMonthMap.set(key, cur);
  }
  const byMonth = [...byMonthMap.entries()]
    .map(([month, v]) => ({ month, ...v }))
    .sort((a, b) => a.month.localeCompare(b.month));

  const monthsSpan = years * 12;
  const tradesPerMonth = monthsSpan > 0 ? closedTrades / monthsSpan : 0;
  const avgCandlesInTrade = avg(closed.map((t) => t.candlesInTrade ?? 0));

  return {
    totalTrades,
    closedTrades,
    winningTrades: wins.length,
    losingTrades:  losses.length,
    winRate,

    totalReturnPct,
    finalEquity,
    maxDrawdownPct: maxDdPct,
    maxDrawdownAbs: maxDdAbs,

    cagr,
    sharpe,
    sortino,
    calmar,
    profitFactor,
    expectancy,
    expectancyUsd,
    avgWinR,
    avgLossR,
    avgRrRealized,

    avgCandlesInTrade,
    tradesPerMonth,

    byShape,
    byCloseReason,
    byMonth,
  };
}

// ─── Equity curve ──────────────────────────────────────────────────────────────

export interface EquityPoint {
  ts:     number;
  equity: number;
}

export function buildEquityCurve(
  trades:        SimTrade[],
  initialEquity: number,
): EquityPoint[] {
  const sorted = [...trades].sort(
    (a, b) => (a.exitTime ?? 0) - (b.exitTime ?? 0),
  );

  let eq = initialEquity;
  const out: EquityPoint[] = [{ ts: 0, equity: eq }];
  for (const t of sorted) {
    eq += t.netPnl ?? 0;
    out.push({ ts: t.exitTime ?? 0, equity: eq });
  }
  return out;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function stddev(arr: number[], mean: number): number {
  if (arr.length === 0) return 0;
  const sq = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
  return Math.sqrt(sq);
}

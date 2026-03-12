import { eq, and, gte, lte, sql, count } from 'drizzle-orm';
import { getDb, schema } from '../db/connection';
import type { WaveStats, TradeStats, DailyReport, TradeMode } from '../types';
import { config } from '../utils/config';
import { logger } from '../utils/logger';

const { wolfeWaves, trades, accountSnapshots } = schema;

// ─── Wave statistics ──────────────────────────────────────────────────────────

export async function getWaveStats(filters?: {
  symbol?: string;
  timeframe?: string;
  fromDate?: Date;
  toDate?: Date;
}): Promise<WaveStats> {
  const db = await getDb();

  const conditions: ReturnType<typeof eq>[] = [];
  if (filters?.symbol) conditions.push(eq(wolfeWaves.symbol, filters.symbol));
  if (filters?.timeframe) conditions.push(eq(wolfeWaves.timeframe, filters.timeframe));
  if (filters?.fromDate) conditions.push(gte(wolfeWaves.detectedAt, filters.fromDate.getTime()));
  if (filters?.toDate) conditions.push(lte(wolfeWaves.detectedAt, filters.toDate.getTime()));

  const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
  const rows = await db.select().from(wolfeWaves).where(whereClause);

  const total = rows.length;
  const perfect = rows.filter((r) => r.isPerfect).length;
  const imperfect = rows.filter((r) => r.shape === 'imperfect').length;
  const fat_mw = rows.filter((r) => r.shape === 'fat_mw').length;
  const long_neck = rows.filter((r) => r.shape === 'long_neck').length;

  const successfulRows = rows.filter((r) => r.reachedTarget1);
  const successRate = total > 0 ? (successfulRows.length / total) * 100 : 0;

  const perfectRows = rows.filter((r) => r.isPerfect);
  const perfectSuccess = perfectRows.filter((r) => r.reachedTarget1).length;
  const perfectSuccessRate = perfectRows.length > 0 ? (perfectSuccess / perfectRows.length) * 100 : 0;

  const imperfectRows = rows.filter((r) => !r.isPerfect);
  const imperfectSuccess = imperfectRows.filter((r) => r.reachedTarget1).length;
  const imperfectSuccessRate = imperfectRows.length > 0 ? (imperfectSuccess / imperfectRows.length) * 100 : 0;

  // By symbol
  const bySymbol: Record<string, { total: number; success: number }> = {};
  for (const r of rows) {
    if (!bySymbol[r.symbol]) bySymbol[r.symbol] = { total: 0, success: 0 };
    bySymbol[r.symbol].total++;
    if (r.reachedTarget1) bySymbol[r.symbol].success++;
  }

  // By timeframe
  const byTimeframe: Record<string, { total: number; success: number }> = {};
  for (const r of rows) {
    if (!byTimeframe[r.timeframe]) byTimeframe[r.timeframe] = { total: 0, success: 0 };
    byTimeframe[r.timeframe].total++;
    if (r.reachedTarget1) byTimeframe[r.timeframe].success++;
  }

  return {
    total, perfect, imperfect, fat_mw, long_neck,
    successRate, perfectSuccessRate, imperfectSuccessRate,
    bySymbol, byTimeframe,
  };
}

// ─── Trade statistics ─────────────────────────────────────────────────────────

export async function getTradeStats(
  mode: TradeMode,
  filters?: {
    symbol?: string;
    timeframe?: string;
    fromDate?: Date;
    toDate?: Date;
  }
): Promise<TradeStats> {
  const db = await getDb();

  const conditions = [eq(trades.mode, mode)];
  if (filters?.symbol) conditions.push(eq(trades.symbol, filters.symbol));
  if (filters?.timeframe) conditions.push(eq(trades.timeframe, filters.timeframe));
  if (filters?.fromDate) conditions.push(gte(trades.entryTime, filters.fromDate.getTime()));
  if (filters?.toDate) conditions.push(lte(trades.entryTime, filters.toDate.getTime()));

  const rows = await db.select().from(trades).where(and(...conditions));

  const totalTrades = rows.length;
  const openTrades = rows.filter((r) => r.status === 'open').length;
  const closedTrades = rows.filter((r) => r.status === 'closed').length;

  const closedRows = rows.filter((r) => r.status === 'closed' && r.pnl !== null);
  const winningTrades = closedRows.filter((r) => Number(r.pnl) >= 0).length;
  const losingTrades = closedRows.filter((r) => Number(r.pnl) < 0).length;
  const winRate = closedRows.length > 0 ? (winningTrades / closedRows.length) * 100 : 0;

  const totalPnl = closedRows.reduce((sum, r) => sum + Number(r.pnl ?? 0), 0);
  const avgPnl = closedRows.length > 0 ? totalPnl / closedRows.length : 0;

  const wins = closedRows.filter((r) => Number(r.pnl) >= 0);
  const losses = closedRows.filter((r) => Number(r.pnl) < 0);

  const avgWin = wins.length > 0 ? wins.reduce((s, r) => s + Number(r.pnl), 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, r) => s + Number(r.pnl), 0) / losses.length) : 0;
  const profitFactor = avgLoss > 0 ? (avgWin * winningTrades) / (avgLoss * losingTrades) : 0;

  // Max drawdown (simplified: largest cumulative drop in running PnL)
  let peak = 0, runningPnl = 0, maxDrawdown = 0;
  for (const r of closedRows) {
    runningPnl += Number(r.pnl ?? 0);
    if (runningPnl > peak) peak = runningPnl;
    const dd = peak - runningPnl;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // By symbol
  const bySymbol: Record<string, { trades: number; pnl: number; winRate: number }> = {};
  for (const r of closedRows) {
    if (!bySymbol[r.symbol]) bySymbol[r.symbol] = { trades: 0, pnl: 0, winRate: 0 };
    bySymbol[r.symbol].trades++;
    bySymbol[r.symbol].pnl += Number(r.pnl ?? 0);
  }
  for (const sym of Object.keys(bySymbol)) {
    const symRows = closedRows.filter((r) => r.symbol === sym);
    const symWins = symRows.filter((r) => Number(r.pnl) >= 0).length;
    bySymbol[sym].winRate = symRows.length > 0 ? (symWins / symRows.length) * 100 : 0;
  }

  // By timeframe
  const byTimeframe: Record<string, { trades: number; pnl: number }> = {};
  for (const r of closedRows) {
    if (!byTimeframe[r.timeframe]) byTimeframe[r.timeframe] = { trades: 0, pnl: 0 };
    byTimeframe[r.timeframe].trades++;
    byTimeframe[r.timeframe].pnl += Number(r.pnl ?? 0);
  }

  // By close reason
  const byCloseReason: Record<string, number> = {};
  for (const r of closedRows) {
    if (r.closeReason) {
      byCloseReason[r.closeReason] = (byCloseReason[r.closeReason] ?? 0) + 1;
    }
  }

  return {
    mode,
    totalTrades, openTrades, closedTrades,
    winningTrades, losingTrades, winRate,
    totalPnl, avgPnl, avgWin, avgLoss,
    profitFactor, maxDrawdown,
    bySymbol, byTimeframe, byCloseReason,
  };
}

// ─── Daily report generation ──────────────────────────────────────────────────

export async function generateDailyReport(mode: TradeMode): Promise<DailyReport> {
  const db = await getDb();

  const today = new Date();
  const dateStr = today.toISOString().split('T')[0];
  const startOfDay = new Date(dateStr + 'T00:00:00Z').getTime();
  const endOfDay = startOfDay + 86_400_000;

  // Today's trades
  const todayTrades = await db.select().from(trades).where(
    and(
      eq(trades.mode, mode),
      gte(trades.entryTime, startOfDay),
      lte(trades.entryTime, endOfDay)
    )
  );

  const closedToday = todayTrades.filter((t) => t.status === 'closed');
  const dailyPnl = closedToday.reduce((s, t) => s + Number(t.pnl ?? 0), 0);
  const wins = closedToday.filter((t) => Number(t.pnl) >= 0).length;
  const winRate = closedToday.length > 0 ? (wins / closedToday.length) * 100 : 0;

  // Open positions
  const openPositions = (await db.select({ c: count() }).from(trades).where(
    and(eq(trades.mode, mode), eq(trades.status, 'open'))
  ))[0]?.c ?? 0;

  // Cumulative PnL from all time
  const allClosed = await db.select({ pnl: trades.pnl }).from(trades).where(
    and(eq(trades.mode, mode), eq(trades.status, 'closed'))
  );
  const cumulativePnl = allClosed.reduce((s, t) => s + Number(t.pnl ?? 0), 0);

  // Balance = initial + cumulative
  const balance = config.initialCapital + cumulativePnl;

  // Waves detected today
  const wavesDetected = (await db.select({ c: count() }).from(wolfeWaves).where(
    and(
      gte(wolfeWaves.detectedAt, startOfDay),
      lte(wolfeWaves.detectedAt, endOfDay)
    )
  ))[0]?.c ?? 0;

  // Save snapshot
  await db.insert(accountSnapshots).values({
    mode,
    date: dateStr,
    balance: balance.toFixed(2),
    dailyPnl: dailyPnl.toFixed(2),
    cumulativePnl: cumulativePnl.toFixed(2),
    tradesOpened: todayTrades.length,
    tradesClosed: closedToday.length,
    wavesDetected,
    winRate: winRate.toFixed(2),
  }).onDuplicateKeyUpdate({
    set: {
      balance: balance.toFixed(2),
      dailyPnl: dailyPnl.toFixed(2),
      cumulativePnl: cumulativePnl.toFixed(2),
      tradesClosed: closedToday.length,
      winRate: winRate.toFixed(2),
    },
  });

  return {
    date: dateStr,
    mode,
    tradesOpened: todayTrades.length,
    tradesClosed: closedToday.length,
    dailyPnl,
    cumulativePnl,
    winRate,
    openPositions: Number(openPositions),
    balance,
    wavesDetected: Number(wavesDetected),
  };
}

export async function getEquityCurve(mode: TradeMode, days = 30) {
  const db = await getDb();
  return db.select().from(accountSnapshots)
    .where(eq(accountSnapshots.mode, mode))
    .orderBy(accountSnapshots.date)
    .limit(days);
}

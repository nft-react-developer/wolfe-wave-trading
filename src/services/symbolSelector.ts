import axios from 'axios';
import { getDb } from '../db/connection';
import { symbolVolume } from '../db/schema';
import { desc, gte, sql } from 'drizzle-orm';
import { config } from '../utils/config';
import { logger } from '../utils/logger';

const COINEX_TICKER_URL = 'https://api.coinex.com/v2/spot/ticker';
const TOP_N             = 5;
const VOLUME_DAYS       = 7;

// ─── Fetch & persist today's ticker volumes ───────────────────────────────────

/**
 * Calls GET /v2/spot/ticker (public, no auth), filters USDT pairs,
 * and upserts today's volume for each symbol into symbol_volume.
 */
export async function snapshotDailyVolumes(): Promise<void> {
  logger.info('SymbolSelector: fetching ticker volumes from CoinEx...');

  const resp = await axios.get(COINEX_TICKER_URL, { timeout: 10_000 });

  // Response: { code: 0, data: [{ market, last, volume, value, ... }] }
  if (resp.data?.code !== 0) {
    throw new Error(`CoinEx ticker error: ${JSON.stringify(resp.data)}`);
  }

  const tickers: Array<{ market: string; value: string }> = resp.data.data ?? [];

  // Keep only USDT spot pairs with valid volume
  const usdtPairs = tickers
    .filter(t => t.market.endsWith('USDT') && Number(t.value) > 0)
    .map(t => ({ symbol: t.market, volumeUsdt: Number(t.value) }));

  if (usdtPairs.length === 0) {
    logger.warn('SymbolSelector: no USDT pairs found in ticker response');
    return;
  }

  const db   = await getDb();
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // Upsert: update if same symbol+date already exists
  for (const pair of usdtPairs) {
    await db.insert(symbolVolume).values({
      symbol:     pair.symbol,
      date,
      volumeUsdt: pair.volumeUsdt.toFixed(2),
    }).onDuplicateKeyUpdate({
      set: { volumeUsdt: pair.volumeUsdt.toFixed(2) },
    });
  }

  logger.info(`SymbolSelector: saved volume for ${usdtPairs.length} USDT pairs on ${date}`);
}

// ─── Select top N symbols by 7-day cumulative volume ─────────────────────────

/**
 * Reads the last VOLUME_DAYS of snapshots and returns the top N symbols
 * ranked by total volume. Falls back to config.scanSymbols if not enough
 * data has been accumulated yet (< 7 days).
 */
export async function getTopSymbols(): Promise<string[]> {
  const db = await getDb();

  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - VOLUME_DAYS);
  const cutoffDate = cutoff.toISOString().slice(0, 10);

  // First check how many distinct days we have — must be >= VOLUME_DAYS
  const [{ daysCount }] = await db
    .select({ daysCount: sql<number>`COUNT(DISTINCT ${symbolVolume.date})` })
    .from(symbolVolume)
    .where(gte(symbolVolume.date, cutoffDate));

  if (Number(daysCount) < VOLUME_DAYS) {
    logger.warn(
      `SymbolSelector: only ${daysCount}/${VOLUME_DAYS} days of history accumulated, ` +
      `keeping config.scanSymbols until full 7-day window is available`
    );
    return config.scanSymbols;
  }

  const rows = await db
    .select({
      symbol:      symbolVolume.symbol,
      totalVolume: sql<number>`SUM(${symbolVolume.volumeUsdt})`,
    })
    .from(symbolVolume)
    .where(gte(symbolVolume.date, cutoffDate))
    .groupBy(symbolVolume.symbol)
    .orderBy(desc(sql`SUM(${symbolVolume.volumeUsdt})`))
    .limit(TOP_N);

  if (rows.length < TOP_N) {
    logger.warn(
      `SymbolSelector: only ${rows.length} symbols with data (<${TOP_N}), ` +
      `falling back to config.scanSymbols until 7 days accumulate`
    );
    return config.scanSymbols;
  }

  const symbols = rows.map(r => r.symbol);
  logger.info('SymbolSelector: top symbols by 7-day volume', { symbols });
  return symbols;
}
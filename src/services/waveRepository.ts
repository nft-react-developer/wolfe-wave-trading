import { eq, and, gte, lte } from 'drizzle-orm';
import type { WolfeWave } from '../types';
import { getDb, schema } from '../db/connection';
import { logger } from '../utils/logger';
import { trades } from '../db/schema';
import type { WolfeWaveRow } from '../db/schema';
import { config } from '../utils/config';

const { wolfeWaves } = schema;

export async function saveWave(wave: WolfeWave): Promise<number> {
  const db = await getDb();

  const [result] = await db.insert(wolfeWaves).values({
    symbol: wave.symbol,
    timeframe: wave.timeframe,
    direction: wave.direction,

    p1Price: wave.p1.price.toFixed(8),
    p2Price: wave.p2.price.toFixed(8),
    p3Price: wave.p3.price.toFixed(8),
    p4Price: wave.p4.price.toFixed(8),
    p5Price: wave.p5.price.toFixed(8),

    p1Time: wave.p1.timestamp,
    p2Time: wave.p2.timestamp,
    p3Time: wave.p3.timestamp,
    p4Time: wave.p4.timestamp,
    p5Time: wave.p5.timestamp,

    p1Index: wave.p1.index,
    p2Index: wave.p2.index,
    p3Index: wave.p3.index,
    p4Index: wave.p4.index,
    p5Index: wave.p5.index,

    isPerfect: wave.isPerfect,
    shape: wave.shape,
    isDoubleWolfe: wave.isDoubleWolfe,

    entryPrice: wave.entryPrice.toFixed(8),
    stopLoss: wave.stopLoss.toFixed(8),
    target1: wave.target1.toFixed(8),
    target2: wave.target2.toFixed(8),
    target3: wave.target3?.toFixed(8),
    target4: wave.target4?.toFixed(8),
    line14Price: wave.line14Price?.toFixed(8),

    ema50: wave.ema50.toFixed(8),
    hasDivergence: false,

    detectedAt: wave.detectedAt,
  });

  const id = result.insertId;
  logger.debug(`Wave saved`, { id, symbol: wave.symbol, direction: wave.direction, shape: wave.shape });
  return id;
}

/**
 * Deduplication: check if a very similar wave was already detected recently
 * (same symbol, direction, and P5 within 0.1% price distance, within last 3 bars worth of time)
 */
export async function waveAlreadyExists(wave: WolfeWave, timeWindowMs: number): Promise<boolean> {
  const db = await getDb();

  const p5Low = wave.p5.price * 0.999;
  const p5High = wave.p5.price * 1.001;
  const minTime = wave.detectedAt - timeWindowMs;

  const existing = await db
    .select({ id: wolfeWaves.id })
    .from(wolfeWaves)
    .where(
      and(
        eq(wolfeWaves.symbol, wave.symbol),
        eq(wolfeWaves.direction, wave.direction),
        eq(wolfeWaves.timeframe, wave.timeframe),
        gte(wolfeWaves.detectedAt, minTime),
        gte(wolfeWaves.p5Price, p5Low.toFixed(8)),
        lte(wolfeWaves.p5Price, p5High.toFixed(8))
      )
    )
    .limit(1);

  return existing.length > 0;
}


export async function tradeAlreadyOpenForWave(wave: WolfeWave, timeWindowMs: number): Promise<boolean> {
  const db = await getDb();

  const minTime = wave.detectedAt - timeWindowMs;

  // Basta con que haya cualquier trade abierto para el mismo
  // símbolo + timeframe + dirección — sin depender del precio de P5
  const existing = await db
    .select({ id: wolfeWaves.id })
    .from(wolfeWaves)
    .innerJoin(trades, eq(trades.wolfeWaveId, wolfeWaves.id))
    .where(
      and(
        eq(wolfeWaves.symbol, wave.symbol),
        eq(wolfeWaves.direction, wave.direction),
        eq(wolfeWaves.timeframe, wave.timeframe),
        gte(wolfeWaves.detectedAt, minTime),
        eq(trades.status, 'open'),
        eq(trades.mode, config.tradingMode),
      )
    )
    .limit(1);

  return existing.length > 0;
}

function rowToWolfeWave(row: WolfeWaveRow): WolfeWave {
  return {
    id:          row.id,
    symbol:      row.symbol,
    timeframe:   row.timeframe,
    direction:   row.direction,

    p1: { index: row.p1Index, price: Number(row.p1Price), timestamp: row.p1Time },
    p2: { index: row.p2Index, price: Number(row.p2Price), timestamp: row.p2Time },
    p3: { index: row.p3Index, price: Number(row.p3Price), timestamp: row.p3Time },
    p4: { index: row.p4Index, price: Number(row.p4Price), timestamp: row.p4Time },
    p5: { index: row.p5Index, price: Number(row.p5Price), timestamp: row.p5Time },

    isPerfect:     row.isPerfect,
    shape:         row.shape,
    isDoubleWolfe: row.isDoubleWolfe,

    entryPrice:  Number(row.entryPrice),
    stopLoss:    Number(row.stopLoss),
    target1:     Number(row.target1),
    target2:     Number(row.target2),
    target3:     row.target3    != null ? Number(row.target3)    : undefined,
    target4:     row.target4    != null ? Number(row.target4)    : undefined,
    line14Price: row.line14Price != null ? Number(row.line14Price) : undefined,

    ema50:         Number(row.ema50),
    macdHistogram: row.macdHistogram != null ? Number(row.macdHistogram) : undefined,

    detectedAt: row.detectedAt,
  };
}

export async function getWaveById(id: number): Promise<WolfeWave | null> {
  const db = await getDb();
  const rows = await db.select().from(wolfeWaves).where(eq(wolfeWaves.id, id)).limit(1);
  if (rows.length === 0) return null;
  return rowToWolfeWave(rows[0]);
}

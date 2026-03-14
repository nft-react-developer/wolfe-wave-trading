import type { Candle, WolfeWave, WavePoint, WolfeDirection } from '../types';
import {
  calcFibLevels,
  calcMACD,
  calcEMA,
  hasMACDDivergence,
  findPivots,
  projectLine,
  type Pivot,
} from '../utils/indicators';
import { config } from '../utils/config';
import { logger } from '../utils/logger';

// ─── Types ────────────────────────────────────────────────────────────────────

type WolfeShape = 'perfect' | 'fat_mw' | 'long_neck' | 'imperfect';

/**
 * All early-return paths must include isPerfect so TypeScript is satisfied.
 * We use `false` as default on invalid paths.
 */
interface ValidationResult {
  valid: boolean;
  isPerfect: boolean;
  reason?: string;
}

// ─── Channel / shape helpers ──────────────────────────────────────────────────

/**
 * "Perfect" Wolfe: the channel is defined by line 1-3 and line 2-4.
 * P4 must fall inside the band formed by projecting those two lines
 * to P4's index. This matches the standard Wolfe Wave channel definition
 * rather than two parallel rails through P1 and P2.
 */
function isInsideChannel(
  p1: WavePoint, p2: WavePoint,
  p3: WavePoint, p4: WavePoint,
): boolean {
  // Project line 1-3 to P4's index
  const line13AtP4 = projectLine(p1.index, p1.price, p3.index, p3.price, p4.index);
  // Project line 2-4 — we already have P4 on this line, so its value is p4.price.
  // Instead check that P3 is inside the band by projecting line 2-4 back to P3.
  const line24AtP3 = projectLine(p2.index, p2.price, p4.index, p4.price, p3.index);

  const inBand = (v: number, a: number, b: number) =>
    v >= Math.min(a, b) && v <= Math.max(a, b);

  // P3 must sit between line 1-3 extended and line 2-4 extended at P3's index
  const line13AtP3 = projectLine(p1.index, p1.price, p3.index, p3.price, p3.index); // = p3.price
  const p3InBand   = inBand(p3.price, line13AtP3, line24AtP3);

  // P4 must sit between line 1-3 and line 2-4 at P4's index
  const line24AtP4 = p4.price; // P4 is on line 2-4 by definition
  const p4InBand   = inBand(p4.price, line13AtP4, line24AtP4);

  return p3InBand && p4InBand;
}

/**
 * Shape classification following Alba Puerro's taxonomy.
 * Called only on waves that passed validation (so isPerfect is already known).
 */
function classifyShape(
  p1: WavePoint, p2: WavePoint, p3: WavePoint,
  p4: WavePoint, p5: WavePoint,
  isPerfect: boolean,
): WolfeShape {
  const totalDuration = (p5.index - p1.index) || 1;
  const neckDuration  = p3.index - p1.index;
  const neckRatio     = neckDuration / totalDuration;

  const neckRange = Math.abs(p2.price - p1.price);
  const bodyRange = Math.abs(p4.price - p3.price) || 1;

  // Fat M/W: P5 is very close to P3 level (<=8% of total range)
  const totalRange = Math.abs(p2.price - p3.price) || 1;
  const p5ToP3Pct  = Math.abs(p5.price - p3.price) / totalRange;
  if (p5ToP3Pct <= 0.08 && bodyRange / neckRange > 0.6) return 'fat_mw';

  // Long neck: neck occupies >50% of total candles OR neck >> body
  if (neckRatio > 0.5 || neckRange / bodyRange > 2) return 'long_neck';

  if (isPerfect) return 'perfect';

  return 'imperfect';
}

// ─── Validation (Alba Puerro rules) ──────────────────────────────────────────

/**
 * Bullish wave — "M" shape.
 *
 *        P2
 *       /  \
 *      /    \    P4
 *    P1      \  /  \
 *             P3    P5  <- entry (long)
 *
 * Rules:
 *  P2 > P1  (P2 is the highest peak)
 *  P2 > P3  (P3 is lower than the peak)
 *  P4 < P2  (P4 bounces but stays below P2)
 *  P4 > P3  (P4 higher than P3)
 *  P5 < P3  (P5 is the new lowest low)
 */
function validateBullish(
  p1: WavePoint, p2: WavePoint, p3: WavePoint,
  p4: WavePoint, p5: WavePoint,
): ValidationResult {
  if (p2.price <= p1.price)
    return { valid: false, isPerfect: false, reason: 'P2 must be higher than P1' };
  if (p2.price <= p3.price)
    return { valid: false, isPerfect: false, reason: 'P3 must be lower than P2' };
  if (p4.price >= p2.price)
    return { valid: false, isPerfect: false, reason: 'P4 must be below P2' };
  if (p4.price <= p3.price)
    return { valid: false, isPerfect: false, reason: 'P4 must be higher than P3' };
  if (p5.price >= p3.price)
    return { valid: false, isPerfect: false, reason: 'P5 must be below P3 (new lowest low)' };

  const isPerfect = p4.price >= p1.price && isInsideChannel(p1, p2, p3, p4);
  return { valid: true, isPerfect };
}

/**
 * Bearish wave — "W" shape.
 *
 *    P5  <- entry (short)
 *   /  \
 *  P3   \    P1
 *        \  /  \
 *         P4    P2
 *
 * Rules:
 *  P2 < P1  (P2 is the lowest trough)
 *  P2 < P3  (P3 is higher than the trough)
 *  P4 > P2  (P4 dips but stays above P2)
 *  P4 < P3  (P4 lower than P3)
 *  P5 > P3  (P5 is the new highest high)
 */
function validateBearish(
  p1: WavePoint, p2: WavePoint, p3: WavePoint,
  p4: WavePoint, p5: WavePoint,
): ValidationResult {
  if (p2.price >= p1.price)
    return { valid: false, isPerfect: false, reason: 'P2 must be lower than P1' };
  if (p2.price >= p3.price)
    return { valid: false, isPerfect: false, reason: 'P3 must be higher than P2' };
  if (p4.price <= p2.price)
    return { valid: false, isPerfect: false, reason: 'P4 must be above P2' };
  if (p4.price >= p3.price)
    return { valid: false, isPerfect: false, reason: 'P4 must be lower than P3' };
  if (p5.price <= p3.price)
    return { valid: false, isPerfect: false, reason: 'P5 must be above P3 (new highest high)' };

  const isPerfect = p4.price <= p1.price && isInsideChannel(p1, p2, p3, p4);
  return { valid: true, isPerfect };
}

// ─── Wave builder ─────────────────────────────────────────────────────────────

function buildWave(
  direction: WolfeDirection,
  p1: WavePoint, p2: WavePoint, p3: WavePoint,
  p4: WavePoint, p5: WavePoint,
  isPerfectFromValidator: boolean,
  symbol: string,
  timeframe: string,
  candles: Candle[],
  emaValues: number[],
  macdResult: ReturnType<typeof calcMACD>,
): WolfeWave | null {

  // EMA50 must be valid at P5
  const ema50 = emaValues[p5.index];
  if (ema50 === undefined || isNaN(ema50)) return null;

  // ── Fibonacci: thrown from P2 to P3 (Alba Puerro methodology) ─────────────
  // calcFibLevels handles direction internally:
  //   bullish → P2 is the high, P3 is the low → fib levels go upward from P3
  //   bearish → P2 is the low,  P3 is the high → fib levels go downward from P3
  // After P5, price reverts:
  //   bullish: price goes UP   → TP1=fib236 (above entry), TP2=fib618 ...
  //   bearish: price goes DOWN → TP1=fib236 (below entry), TP2=fib618 ...
  const fib = calcFibLevels(p2.price, p3.price, direction);

  const target1 = fib.fib236;   // 23.6% — close 50%, move SL to breakeven
  const target2 = fib.fib618;   // 61.8% — standard exit
  const target3 = fib.fib100;   // 100%  — fat M/W only (back to P2)
  const target4 = fib.fib1618;  // 161.8% extension — fat M/W only

  // Sanity: targets must be in the correct direction from P5
  if (direction === 'bullish' && target1 <= p5.price) return null;
  if (direction === 'bearish' && target1 >= p5.price) return null;

  // ── Entry & Stop Loss ──────────────────────────────────────────────────────
  // Entry at P5 — Alba Puerro: enter immediately on wave identification,
  // do NOT wait for the line 1-3 crossover (75% of waves never cross it).
  const entryPrice = p5.price;

  // SL buffer: 10% of the P3→P5 leg, capped at 2% of the entry price.
  // The cap prevents absurdly wide stops on high-volatility legs while
  // still giving P5 a small margin so micro-wicks don't trigger the SL.
  const lastLegSize  = Math.abs(p5.price - p3.price);
  const rawBuffer    = lastLegSize * 0.10;
  const maxBuffer    = p5.price * 0.02;          // never more than 2% of price
  const slBuffer     = Math.min(rawBuffer, maxBuffer);

  const stopLoss = direction === 'bullish'
    ? p5.price - slBuffer   // long: SL just below P5
    : p5.price + slBuffer;  // short: SL just above P5

  // ── Line 1-4 projection (Bill Wolfe price target) ─────────────────────────
  const line14Price = projectLine(
    p1.index, p1.price,
    p4.index, p4.price,
    p5.index + 1,
  );

  // ── Shape classification ───────────────────────────────────────────────────
  const shape = classifyShape(p1, p2, p3, p4, p5, isPerfectFromValidator);

  // isPerfect is true when shape is 'perfect' OR when the validator said so
  // and the shape ended up as 'fat_mw' (fat M/W can still have perfect structure)
  const isPerfect = shape === 'perfect' || (isPerfectFromValidator && shape === 'fat_mw');
  const isFatMW   = shape === 'fat_mw';

  // ── MACD divergence at P5 ─────────────────────────────────────────────────
  const start = Math.max(0, p5.index - 10);
  const lookbackCandles = candles.slice(start, p5.index + 1);
  const lookbackMacd = {
    macd:      macdResult.macd.slice(start, p5.index + 1),
    signal:    macdResult.signal.slice(start, p5.index + 1),
    histogram: macdResult.histogram.slice(start, p5.index + 1),
  };
  const hasDivergence  = hasMACDDivergence(lookbackCandles, direction, lookbackMacd, 5);
  const macdHistogram  = macdResult.histogram[p5.index] ?? NaN;

  logger.debug('Wave built', {
    symbol, timeframe, direction, shape, isPerfect, isFatMW,
    p5: p5.price, entry: entryPrice, sl: stopLoss,
    tp1: target1, tp2: target2, divergence: hasDivergence,
  });

  return {
    symbol,
    timeframe,
    direction,
    p1, p2, p3, p4, p5,
    isPerfect,
    shape,
    isDoubleWolfe: false, // Double Wolfe detection is done in the scanner
    entryPrice,
    stopLoss,
    target1,
    target2,
    target3: isFatMW ? target3 : undefined,
    target4: isFatMW ? target4 : undefined,
    line14Price,
    ema50,
    macdHistogram: isNaN(macdHistogram) ? undefined : macdHistogram,
    detectedAt: Date.now(),
  };
}

// ─── Timeframe helpers ───────────────────────────────────────────────────────

/**
 * Returns pivot detection strength (candles on each side) based on timeframe.
 * Higher timeframes require a wider lookback to filter out noise.
 */
function pivotStrengthForTimeframe(timeframe: string): number {
  const map: Record<string, number> = {
    '1min':  2,
    '3min':  2,
    '5min':  3,
    '15min': 3,
    '30min': 4,
    '1hour': 4,
    '2hour': 5,
    '4hour': 6,
    '1day':  7,
  };
  return map[timeframe] ?? 3;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function detectWolfeWaves(
  candles: Candle[],
  symbol: string,
  timeframe: string,
): WolfeWave[] {
  // Need enough candles for EMA50 warm-up (50) + MACD slow (18) + buffer
  if (candles.length < 60) return [];

  const closes     = candles.map((c) => c.close);
  const emaValues  = calcEMA(closes, config.emaPeriod);
  const macdResult = calcMACD(candles, config.macd.fast, config.macd.slow, config.macd.signal);

  // Pivot strength scales with timeframe — higher timeframes need a wider
  // lookback to avoid detecting noise as significant pivot points.
  const pivotStrength = pivotStrengthForTimeframe(timeframe);
  const pivots        = findPivots(candles, pivotStrength);

  if (pivots.length < 5) return [];

  const waves: WolfeWave[] = [];

  // Only evaluate wave candidates where P5 is the most recent pivot.
  // This prevents the bot from acting on historical waves that have already
  // resolved (P5 is not the last pivot in the array means the pattern is old).
  const lastPivotIndex = pivots.length - 1;

  for (let i = 0; i <= pivots.length - 5; i++) {
    // Skip if this group's P5 is not the last pivot
    if (i + 4 !== lastPivotIndex) continue;

    const [pA, pB, pC, pD, pE] = pivots.slice(i, i + 5) as [Pivot, Pivot, Pivot, Pivot, Pivot];

    // ── Bullish (M shape): low-high-low-high-low ──────────────────────────
    if (
      pA.type === 'low'  && pB.type === 'high' &&
      pC.type === 'low'  && pD.type === 'high' && pE.type === 'low'
    ) {
      const p1: WavePoint = { index: pA.index, price: pA.price, timestamp: pA.timestamp };
      const p2: WavePoint = { index: pB.index, price: pB.price, timestamp: pB.timestamp };
      const p3: WavePoint = { index: pC.index, price: pC.price, timestamp: pC.timestamp };
      const p4: WavePoint = { index: pD.index, price: pD.price, timestamp: pD.timestamp };
      const p5: WavePoint = { index: pE.index, price: pE.price, timestamp: pE.timestamp };

      const v = validateBullish(p1, p2, p3, p4, p5);
      if (v.valid) {
        const wave = buildWave(
          'bullish', p1, p2, p3, p4, p5, v.isPerfect,
          symbol, timeframe, candles, emaValues, macdResult,
        );
        if (wave) waves.push(wave);
      }
    }

    // ── Bearish (W shape): high-low-high-low-high ─────────────────────────
    if (
      pA.type === 'high' && pB.type === 'low'  &&
      pC.type === 'high' && pD.type === 'low'  && pE.type === 'high'
    ) {
      const p1: WavePoint = { index: pA.index, price: pA.price, timestamp: pA.timestamp };
      const p2: WavePoint = { index: pB.index, price: pB.price, timestamp: pB.timestamp };
      const p3: WavePoint = { index: pC.index, price: pC.price, timestamp: pC.timestamp };
      const p4: WavePoint = { index: pD.index, price: pD.price, timestamp: pD.timestamp };
      const p5: WavePoint = { index: pE.index, price: pE.price, timestamp: pE.timestamp };

      const v = validateBearish(p1, p2, p3, p4, p5);
      if (v.valid) {
        const wave = buildWave(
          'bearish', p1, p2, p3, p4, p5, v.isPerfect,
          symbol, timeframe, candles, emaValues, macdResult,
        );
        if (wave) waves.push(wave);
      }
    }
  }

  return waves;
}
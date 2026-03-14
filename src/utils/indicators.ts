import type { Candle } from '../types';

// ─── EMA ──────────────────────────────────────────────────────────────────────

export function calcEMA(values: number[], period: number): number[] {
  if (values.length < period) return [];

  const k = 2 / (period + 1);
  const result: number[] = new Array(values.length).fill(NaN);

  // Seed with SMA
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  result[period - 1] = sum / period;

  for (let i = period; i < values.length; i++) {
    result[i] = values[i] * k + result[i - 1] * (1 - k);
  }

  return result;
}

export function latestEMA(candles: Candle[], period: number): number {
  const closes = candles.map((c) => c.close);
  const emas = calcEMA(closes, period);
  return emas[emas.length - 1] ?? NaN;
}

// ─── MACD ─────────────────────────────────────────────────────────────────────

export interface MACDResult {
  macd: number[];
  signal: number[];
  histogram: number[];
}

export function calcMACD(
  candles: Candle[],
  fast = 9,
  slow = 18,
  signal = 9
): MACDResult {
  const closes = candles.map((c) => c.close);
  const fastEMA = calcEMA(closes, fast);
  const slowEMA = calcEMA(closes, slow);

  const macdLine: number[] = closes.map((_, i) => {
    if (isNaN(fastEMA[i]) || isNaN(slowEMA[i])) return NaN;
    return fastEMA[i] - slowEMA[i];
  });

  // Remove leading NaNs for signal calculation
  const validMacd = macdLine.filter((v) => !isNaN(v));
  const signalRaw = calcEMA(validMacd, signal);

  // Re-align signal to original length
  const offset = macdLine.findIndex((v) => !isNaN(v));
  const signalLine: number[] = new Array(macdLine.length).fill(NaN);
  signalRaw.forEach((v, i) => {
    signalLine[offset + i] = v;
  });

  const histogram = macdLine.map((v, i) => {
    if (isNaN(v) || isNaN(signalLine[i])) return NaN;
    return v - signalLine[i];
  });

  return { macd: macdLine, signal: signalLine, histogram };
}

// ─── Fibonacci levels ────────────────────────────────────────────────────────

export interface FibLevels {
  fib0: number;     // 0%   = P2 (start)
  fib236: number;   // 23.6%
  fib382: number;   // 38.2%
  fib500: number;   // 50%
  fib618: number;   // 61.8%
  fib100: number;   // 100% = P3 (end)
  fib1618: number;  // 161.8% extension
}

/**
 * Compute Fibonacci retracement levels from P2 to P3.
 * Alba Puerro: throw Fibonacci from P2 to P3
 *   - Bullish wave → P2 is the high, P3 is the low (draw top-down)
 *   - Bearish wave → P2 is the low, P3 is the high (draw bottom-up)
 */
export function calcFibLevels(p2Price: number, p3Price: number, direction: 'bullish' | 'bearish'): FibLevels {
  const range = Math.abs(p3Price - p2Price);
  const isDown = direction === 'bullish'; // bullish: P2 high → P3 low

  const level = (pct: number) =>
    isDown
      ? p2Price - range * pct          // downward fib from P2
      : p2Price + range * pct;         // upward fib from P2

  return {
    fib0:    p2Price,
    fib236:  level(0.236),
    fib382:  level(0.382),
    fib500:  level(0.5),
    fib618:  level(0.618),
    fib100:  p3Price,
    fib1618: isDown
      ? p2Price - range * 1.618
      : p2Price + range * 1.618,
  };
}

// ─── Divergence detection ─────────────────────────────────────────────────────

/**
 * Simple divergence check between price and MACD histogram at the last two peaks/troughs.
 * Returns true if a divergence is detected that supports the wave direction.
 */
export function hasMACDDivergence(
  candles: Candle[],
  direction: 'bullish' | 'bearish',
  macdResult: MACDResult,
  lookback = 5
): boolean {
  const n = candles.length;
  if (n < lookback * 2) return false;

  const recent = candles.slice(-lookback);
  const recentHist = macdResult.histogram.slice(-lookback);

  if (direction === 'bullish') {
    // Bullish divergence: price makes lower lows but MACD histogram makes higher lows
    const priceLow1 = Math.min(...recent.slice(0, lookback / 2 | 0).map((c) => c.low));
    const priceLow2 = Math.min(...recent.slice(lookback / 2 | 0).map((c) => c.low));
    const histLow1 = Math.min(...recentHist.slice(0, lookback / 2 | 0).filter((v) => !isNaN(v)));
    const histLow2 = Math.min(...recentHist.slice(lookback / 2 | 0).filter((v) => !isNaN(v)));
    return priceLow2 < priceLow1 && histLow2 > histLow1;
  } else {
    // Bearish divergence: price makes higher highs but MACD histogram makes lower highs
    const priceHigh1 = Math.max(...recent.slice(0, lookback / 2 | 0).map((c) => c.high));
    const priceHigh2 = Math.max(...recent.slice(lookback / 2 | 0).map((c) => c.high));
    const histHigh1 = Math.max(...recentHist.slice(0, lookback / 2 | 0).filter((v) => !isNaN(v)));
    const histHigh2 = Math.max(...recentHist.slice(lookback / 2 | 0).filter((v) => !isNaN(v)));
    return priceHigh2 > priceHigh1 && histHigh2 < histHigh1;
  }
}

// ─── Line projection ──────────────────────────────────────────────────────────

/**
 * Given two points (index, price), project the price at a target index.
 * Used for line 1-4 target projection.
 */
export function projectLine(
  idx1: number, price1: number,
  idx2: number, price2: number,
  targetIdx: number
): number {
  if (idx2 === idx1) return price1;
  const slope = (price2 - price1) / (idx2 - idx1);
  return price1 + slope * (targetIdx - idx1);
}

// ─── Pivot finding ────────────────────────────────────────────────────────────

export interface Pivot {
  index: number;
  price: number;
  timestamp: number;
  type: 'high' | 'low';
}

/**
 * Find alternating pivot highs and lows in a candle series.
 * Uses closing prices as per Alba Puerro's methodology — close values
 * represent the market consensus and filter out wick noise.
 * A pivot high is a close higher than the closes of the surrounding candles.
 * A pivot low is a close lower than the closes of the surrounding candles.
 */
export function findPivots(candles: Candle[], strength = 3): Pivot[] {
  const pivots: Pivot[] = [];

  for (let i = strength; i < candles.length - strength; i++) {
    const current = candles[i];

    let isHigh = true;
    let isLow  = true;

    for (let j = i - strength; j <= i + strength; j++) {
      if (j === i) continue;
      if (candles[j].close >= current.close) isHigh = false;
      if (candles[j].close <= current.close) isLow  = false;
    }

    if (isHigh) {
      // Price stored as close (not high wick)
      pivots.push({ index: i, price: current.close, timestamp: current.timestamp, type: 'high' });
    } else if (isLow) {
      // Price stored as close (not low wick)
      pivots.push({ index: i, price: current.close, timestamp: current.timestamp, type: 'low' });
    }
  }

  // Remove consecutive same-type pivots (keep most extreme close)
  const filtered: Pivot[] = [];
  for (const p of pivots) {
    const last = filtered[filtered.length - 1];
    if (!last || last.type !== p.type) {
      filtered.push(p);
    } else {
      if (p.type === 'high' && p.price > last.price) filtered[filtered.length - 1] = p;
      if (p.type === 'low'  && p.price < last.price) filtered[filtered.length - 1] = p;
    }
  }

  return filtered;
}
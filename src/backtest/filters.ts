import type { Candle, WolfeWave } from '../types';
import { calcEMA } from '../utils/indicators';
import type { BacktestFilters } from './types';

// ─── Filtros del backtest ─────────────────────────────────────────────────────
// Estos filtros se aplican DESPUÉS de que `detectWolfeWaves()` validó la
// geometría. Cada uno corresponde a una recomendación del PDF de Alba Puerro
// y se puede activar/desactivar por config para A/B testing.

export interface FilterResult {
  ok:     boolean;
  reason?: string;
  meta?:  Record<string, number | string | boolean>;
}

export function passesFilters(
  wave: WolfeWave,
  candles: Candle[],          // velas hasta el momento de detección (slice visible)
  filters: BacktestFilters,
): FilterResult {
  const meta: Record<string, number | string | boolean> = {};

  // ── 1. Volumen en P5 (§13 PDF) ──────────────────────────────────────────────
  if (filters.minP5VolumeRatio !== undefined) {
    const window = filters.volumeWindow ?? 20;
    const ratio = computeP5VolumeRatio(wave, candles, window);
    meta.p5VolRatio = ratio;
    if (ratio < filters.minP5VolumeRatio) {
      return {
        ok: false,
        reason: `vol P5 ratio ${ratio.toFixed(2)} < ${filters.minP5VolumeRatio}`,
        meta,
      };
    }
  }

  // ── 2. Forma de la onda (§9) ────────────────────────────────────────────────
  if (filters.minShapeScore !== undefined) {
    const shapeScore = shapeScoreBase(wave);
    meta.shapeScore = shapeScore;
    if (shapeScore < filters.minShapeScore) {
      return {
        ok: false,
        reason: `shape score ${shapeScore} < ${filters.minShapeScore} (${wave.shape})`,
        meta,
      };
    }
  }

  // ── 3. RR mínimo sobre TP2 ──────────────────────────────────────────────────
  if (filters.minRrRatio !== undefined) {
    const rr =
      Math.abs(wave.target2 - wave.entryPrice) /
      Math.max(Math.abs(wave.entryPrice - wave.stopLoss), 1e-9);
    meta.rr = rr;
    if (rr < filters.minRrRatio) {
      return { ok: false, reason: `RR ${rr.toFixed(2)} < ${filters.minRrRatio}`, meta };
    }
  }

  return { ok: true, meta };
}

// ─── Helpers expuestos ────────────────────────────────────────────────────────

/**
 * Volumen en P5 vs promedio de las últimas N velas.
 * Toma el MAX de una ventana ±2 alrededor del P5 ("zona del P5" según §13).
 */
export function computeP5VolumeRatio(
  wave: WolfeWave,
  candles: Candle[],
  window: number,
): number {
  const idx = wave.p5.index;
  if (idx < window) return 0;

  const baseStart = Math.max(0, idx - window);
  const baseSlice = candles.slice(baseStart, idx);
  if (baseSlice.length === 0) return 0;
  const avg = baseSlice.reduce((s, c) => s + c.volume, 0) / baseSlice.length;
  if (avg <= 0) return 0;

  const zone = candles.slice(Math.max(0, idx - 2), Math.min(candles.length, idx + 1));
  const maxVol = Math.max(...zone.map((c) => c.volume));

  return maxVol / avg;
}

/**
 * Volumen post-P5: devuelve el mayor volumen aparecido tras P5 vs el del P5.
 * Si retorna > 1.0 significa que apareció una vela con MÁS volumen que la P5
 * — señal de wolfe fallando según §13.
 */
export function postP5VolumeRatio(
  wave: WolfeWave,
  candles: Candle[],
  currentIdx: number,
): number {
  const p5Idx = wave.p5.index;
  if (currentIdx <= p5Idx) return 0;

  const p5Vol = candles[p5Idx]?.volume ?? 0;
  if (p5Vol <= 0) return 0;

  let maxPost = 0;
  for (let i = p5Idx + 1; i <= currentIdx; i++) {
    if (candles[i].volume > maxPost) maxPost = candles[i].volume;
  }
  return maxPost / p5Vol;
}

/**
 * Score base por forma de la onda, calibrado con las estadísticas del PDF (§9):
 *   - gorda M/W: 75-85% éxito
 *   - perfecta: 75%
 *   - cuello largo: 50-60%
 *   - imperfecta: 52%
 */
export function shapeScoreBase(wave: WolfeWave): number {
  switch (wave.shape) {
    case 'fat_mw':    return 25;
    case 'perfect':   return 22;
    case 'imperfect': return 15;
    case 'long_neck': return 12;
    default:          return 10;
  }
}

/**
 * Indica si el precio rompió la EMA50 en favor del trade entre `fromIdx` e
 * `toIdx` (inclusive). Bullish: precio cruzó por encima.
 */
export function brokeEMA50(
  candles: Candle[],
  fromIdx: number,
  toIdx: number,
  direction: 'bullish' | 'bearish',
  period = 50,
): boolean {
  if (toIdx >= candles.length || fromIdx < 0) return false;

  const closes = candles.slice(0, toIdx + 1).map((c) => c.close);
  const ema = calcEMA(closes, period);

  for (let i = fromIdx; i <= toIdx; i++) {
    const e = ema[i];
    if (!isFinite(e)) continue;
    if (direction === 'bullish' && candles[i].close > e) return true;
    if (direction === 'bearish' && candles[i].close < e) return true;
  }
  return false;
}

import fs from 'fs';
import path from 'path';
import axios from 'axios';
import type { Candle } from '../types';
import { logger } from '../utils/logger';

// ─── DataLoader ───────────────────────────────────────────────────────────────
// Descarga histórico OHLCV de CoinEx para backtest y lo cachea en disco.
// La API pública de CoinEx (/v2/spot/kline) limita ~1000 velas por request y
// no acepta paginación por timestamp; iteramos hacia atrás usando `end_time`.
//
// Cache: archivos JSON por símbolo+timeframe en `backtest/data/`.
// El cache es incremental: si ya existe, se intenta extender hacia atrás y/o
// hacia adelante hasta cubrir el rango pedido.

const COINEX_BASE = 'https://api.coinex.com/v2';
const KLINE_PATH  = '/spot/kline';

const TIMEFRAME_MS: Record<string, number> = {
  '1min':   60_000,
  '3min':   3 * 60_000,
  '5min':   5 * 60_000,
  '15min':  15 * 60_000,
  '30min':  30 * 60_000,
  '1hour':  60 * 60_000,
  '2hour':  2 * 60 * 60_000,
  '4hour':  4 * 60 * 60_000,
  '6hour':  6 * 60 * 60_000,
  '12hour': 12 * 60 * 60_000,
  '1day':   24 * 60 * 60_000,
};

export function tfToMs(tf: string): number {
  const v = TIMEFRAME_MS[tf];
  if (!v) throw new Error(`Timeframe desconocido: ${tf}`);
  return v;
}

export function getDataDir(): string {
  // El directorio se resuelve relativo a la raíz del proyecto.
  // process.cwd() devuelve la ruta de ejecución (tsx desde la raíz).
  return path.resolve(process.cwd(), 'backtest', 'data');
}

export function cachePath(symbol: string, timeframe: string): string {
  const safe = symbol.replace(/[^A-Za-z0-9]/g, '_');
  return path.join(getDataDir(), `${safe}_${timeframe}.json`);
}

// ─── Lectura/escritura del cache ──────────────────────────────────────────────

function readCache(file: string): Candle[] {
  if (!fs.existsSync(file)) return [];
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as Candle[];
    // Sanity: ordenar por timestamp ascendente y eliminar duplicados
    const map = new Map<number, Candle>();
    for (const c of parsed) map.set(c.timestamp, c);
    return [...map.values()].sort((a, b) => a.timestamp - b.timestamp);
  } catch (err) {
    logger.warn(`Cache corrupto en ${file} — se descartará: ${(err as Error).message}`);
    return [];
  }
}

function writeCache(file: string, candles: Candle[]): void {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(candles), 'utf8');
}

// ─── Fetch de un batch desde CoinEx ───────────────────────────────────────────
// Nota: la API V2 no permite paginar hacia atrás explícitamente, devuelve las
// últimas N velas. Para series largas usamos `end_time` para pivotar.

async function fetchBatch(
  symbol: string,
  timeframe: string,
  limit: number,
  endTimeMs?: number,
): Promise<Candle[]> {
  const params: Record<string, unknown> = {
    market:  symbol,
    period:  timeframe,
    limit,
  };
  if (endTimeMs) {
    // CoinEx V2 acepta `end_time` en segundos en algunos endpoints;
    // probamos con `before` (timestamp ms) como query auxiliar.
    // Si no es soportado, devolverá las últimas N velas — caller filtrará.
    params.end_time = Math.floor(endTimeMs / 1000);
  }

  try {
    const resp = await axios.get(COINEX_BASE + KLINE_PATH, { params, timeout: 15_000 });
    const raw: Array<{
      created_at: number;
      open: string; close: string; high: string; low: string; volume: string;
    }> = resp.data?.data ?? [];

    return raw.map((k) => ({
      timestamp: k.created_at,
      open:   Number(k.open),
      high:   Number(k.high),
      low:    Number(k.low),
      close:  Number(k.close),
      volume: Number(k.volume),
    }));
  } catch (err) {
    const msg = (err as Error).message;
    logger.error(`fetchBatch CoinEx ${symbol}/${timeframe} fallo: ${msg}`);
    return [];
  }
}

// ─── API pública ──────────────────────────────────────────────────────────────

export interface LoadOptions {
  /** Si true, usa el cache si existe y NO intenta refrescar (modo offline). */
  offlineOnly?: boolean;
  /** Si true, fuerza re-descarga ignorando cache. */
  forceRefresh?: boolean;
  /** Máximo de velas a obtener si no se especifica rango. */
  maxCandles?: number;
}

/**
 * Carga histórico OHLCV con cache local. Si el rango pedido no está
 * completamente cacheado, intenta completarlo descargando desde CoinEx.
 *
 * Devuelve velas ordenadas ascendentemente por timestamp.
 */
export async function loadCandles(
  symbol: string,
  timeframe: string,
  startTs?: number,
  endTs?: number,
  opts: LoadOptions = {},
): Promise<Candle[]> {
  const tfMs    = tfToMs(timeframe);
  const file    = cachePath(symbol, timeframe);
  const cached  = opts.forceRefresh ? [] : readCache(file);

  // Si no hay rango, usar cache si está, sino bajar las últimas N
  if (!startTs && !endTs) {
    if (cached.length > 0 && opts.offlineOnly) return cached;
    if (cached.length > 0 && !opts.forceRefresh) {
      // Refrescar con las velas más recientes (top-up)
      const fresh = await fetchBatch(symbol, timeframe, 1000);
      const merged = mergeCandles(cached, fresh);
      writeCache(file, merged);
      return merged;
    }
    const fresh = await fetchBatch(symbol, timeframe, opts.maxCandles ?? 1000);
    writeCache(file, fresh);
    return fresh;
  }

  // Modo offline → solo usar cache
  if (opts.offlineOnly) {
    return cached.filter((c) =>
      (!startTs || c.timestamp >= startTs) &&
      (!endTs   || c.timestamp <= endTs),
    );
  }

  // Heurística para llenar el rango:
  // 1. Si cache cubre el inicio → top-up hacia el final
  // 2. Si cache es vacío o no cubre → iterar batches hacia atrás desde endTs
  //    hasta cubrir startTs
  const desiredStart = startTs ?? (endTs ?? Date.now()) - 1000 * tfMs;
  const desiredEnd   = endTs   ?? Date.now();

  let merged = [...cached];

  // Top-up al final (velas más recientes)
  const cacheEnd = merged.length > 0 ? merged[merged.length - 1].timestamp : 0;
  if (cacheEnd < desiredEnd) {
    const recent = await fetchBatch(symbol, timeframe, 1000);
    merged = mergeCandles(merged, recent);
  }

  // Extender hacia atrás si no cubrimos desiredStart
  let cacheStart = merged.length > 0 ? merged[0].timestamp : desiredEnd;
  let safetyIter = 0;
  while (cacheStart > desiredStart && safetyIter < 50) {
    safetyIter++;
    const batch = await fetchBatch(symbol, timeframe, 1000, cacheStart - tfMs);
    if (batch.length === 0) break;
    const before = merged.length;
    merged = mergeCandles(merged, batch);
    if (merged.length === before) break;     // sin nuevas velas → la API no extiende más
    cacheStart = merged[0].timestamp;
    await sleep(150);                        // rate-limit cortés
  }

  writeCache(file, merged);

  return merged.filter((c) => c.timestamp >= desiredStart && c.timestamp <= desiredEnd);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mergeCandles(a: Candle[], b: Candle[]): Candle[] {
  const map = new Map<number, Candle>();
  for (const c of a) map.set(c.timestamp, c);
  for (const c of b) map.set(c.timestamp, c);
  return [...map.values()].sort((x, y) => x.timestamp - y.timestamp);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

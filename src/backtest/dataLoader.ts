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
// CoinEx V2 (/v2/spot/kline) NO acepta paginación por timestamp. Sólo devuelve
// las últimas `limit` velas (max ~1000). Para reconstruir histórico largo
// no hay endpoint público — la mejor opción es ir acumulando con cada corrida
// y usar cache local.

interface CoinExKlineRaw {
  created_at: number;
  open:   string;
  close:  string;
  high:   string;
  low:    string;
  volume: string;
}

async function fetchBatch(
  symbol: string,
  timeframe: string,
  limit: number,
  _endTimeMs?: number,            // prefix _ — V2 no lo soporta, lo dejamos por compat
): Promise<Candle[]> {
  // CoinEx V2 limita a 1000 velas por request
  const cappedLimit = Math.min(Math.max(limit, 1), 1000);

  try {
    const resp = await axios.get(COINEX_BASE + KLINE_PATH, {
      params: { market: symbol, period: timeframe, limit: cappedLimit },
      timeout: 15_000,
    });

    // CoinEx V2 envuelve la respuesta en { code, data, message }
    // Cuando hay error, `data` puede ser null/string/objeto — protegerse.
    const body = resp.data;

    if (body?.code !== undefined && body.code !== 0) {
      logger.error(
        `CoinEx ${symbol}/${timeframe} respondió con error code=${body.code}: ${body.message ?? '(sin mensaje)'}`,
      );
      return [];
    }

    const raw = body?.data;
    if (!Array.isArray(raw)) {
      logger.error(
        `CoinEx ${symbol}/${timeframe} data no es array. Body: ${JSON.stringify(body).slice(0, 300)}`,
      );
      return [];
    }

    return (raw as CoinExKlineRaw[]).map((k) => ({
      timestamp: Number(k.created_at),
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

  // CoinEx V2 NO soporta paginación por timestamp en /spot/kline — sólo
  // devuelve las últimas N velas (max 1000). Para histórico profundo hay
  // que acumular cache corriendo el loader periódicamente.
  //
  // Estrategia:
  //   1. Top-up con últimas 1000 velas y mergear con cache existente.
  //   2. Filtrar por rango pedido.
  //   3. Si el rango pedido no se cubre, avisar al usuario en el log.
  const desiredStart = startTs ?? (endTs ?? Date.now()) - 1000 * tfMs;
  const desiredEnd   = endTs   ?? Date.now();

  let merged = [...cached];
  const recent = await fetchBatch(symbol, timeframe, 1000);
  merged = mergeCandles(merged, recent);
  writeCache(file, merged);

  const result = merged.filter(
    (c) => c.timestamp >= desiredStart && c.timestamp <= desiredEnd,
  );

  if (result.length === 0) {
    logger.warn(
      `loadCandles: 0 velas en el rango ${new Date(desiredStart).toISOString()} → ${new Date(desiredEnd).toISOString()} para ${symbol}/${timeframe}. ` +
      `Cache tiene ${merged.length} velas, oldest: ${merged.length > 0 ? new Date(merged[0].timestamp).toISOString() : 'n/a'}. ` +
      `CoinEx V2 sólo retorna las últimas 1000 velas — para histórico profundo hay que correr el loader periódicamente y dejar que se acumule el cache.`,
    );
  } else if (merged.length > 0 && merged[0].timestamp > desiredStart) {
    logger.warn(
      `loadCandles: rango pedido empieza antes del cache (${new Date(desiredStart).toISOString()} vs cache desde ${new Date(merged[0].timestamp).toISOString()}). ` +
      `Se backtesteará desde donde alcanza el cache.`,
    );
  }

  // Mantener referencia silenciada al sleep helper (lo usaba el viejo loop
  // de paginación). Lo dejamos en el archivo por si re-implementamos
  // paginación cuando CoinEx la soporte.
  void sleep;

  return result;
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

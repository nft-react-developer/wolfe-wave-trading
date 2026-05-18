#!/usr/bin/env tsx
/**
 * batchRunner.ts — Orquestador de backtests para servidor
 *
 * Loop infinito que:
 *  1. Corre backtest para cada combinación símbolo × timeframe configurada.
 *  2. Guarda los reportes en backtest/reports/.
 *  3. Acumula el cache de velas en disco con cada corrida (enriquece el histórico).
 *  4. Cada 7 días manda un resumen semanal por Telegram.
 *
 * Uso:
 *   tsx src/backtest/batchRunner.ts
 *
 * Variables de entorno opcionales (además de las estándar del .env):
 *   BACKTEST_TIMEFRAMES   Timeframes a backtestar (default: "15min,30min")
 *   BACKTEST_SYMBOLS      Símbolos override (default: top N por volumen 7d vía getTopSymbols, igual que el bot real)
 *   BACKTEST_INTERVAL_H   Horas entre cada ronda de backtests (default: 6)
 *   BACKTEST_ONLY_BULLISH true|false (default: true)
 *   BACKTEST_ENTRY_MODE   market_at_p5 | confirm_candle | limit_at_p5 (default: market_at_p5)
 */

import 'dotenv/config';
import { runBacktest, defaultConfig } from './runner';
import { writeReport } from './report';
import { sendWeeklyReport } from './weeklyReport';
import { getTopSymbols } from '../services/symbolSelector';
import { logger } from '../utils/logger';
import type { BacktestResult } from './types';

// ─── Configuración ────────────────────────────────────────────────────────────

const TIMEFRAMES = (process.env.BACKTEST_TIMEFRAMES ?? '15min,30min')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Si se define BACKTEST_SYMBOLS en el .env se usa como override explícito.
// Si no, cada ronda consulta getTopSymbols() — la misma fuente que el bot real
// (top N por volumen acumulado 7 días en symbol_volume).
const SYMBOLS_OVERRIDE = process.env.BACKTEST_SYMBOLS
  ? process.env.BACKTEST_SYMBOLS.split(',').map((s) => s.trim()).filter(Boolean)
  : null;

const INTERVAL_H  = Number(process.env.BACKTEST_INTERVAL_H  ?? 6);
const ONLY_BULLISH = (process.env.BACKTEST_ONLY_BULLISH ?? 'true') === 'true';
const ENTRY_MODE  = (process.env.BACKTEST_ENTRY_MODE ?? 'market_at_p5') as
  'market_at_p5' | 'confirm_candle' | 'limit_at_p5';

// ─── Estado ───────────────────────────────────────────────────────────────────

interface RunRecord {
  symbol:    string;
  timeframe: string;
  runId:     string;
  result:    BacktestResult;
  ts:        number;        // timestamp Unix del run
}

const weeklyHistory: RunRecord[] = [];
let lastWeeklyReportTs = 0;   // timestamp del último reporte enviado

// ─── Main loop ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  logger.info('=== Backtest Server arrancando ===');
  logger.info(`Símbolos:    ${SYMBOLS_OVERRIDE ? SYMBOLS_OVERRIDE.join(', ') + ' (override)' : 'dinámico — top N por volumen 7d (igual que el bot real)'}`);
  logger.info(`Timeframes:  ${TIMEFRAMES.join(', ')}`);
  logger.info(`Intervalo:   ${INTERVAL_H}h`);
  logger.info(`Solo bullish: ${ONLY_BULLISH}`);
  logger.info(`Entry mode:  ${ENTRY_MODE}`);

  // Loop infinito: corre → duerme → corre → ...
  while (true) {
    const roundStart = Date.now();
    logger.info(`\n──────── Iniciando ronda ${new Date(roundStart).toISOString()} ────────`);

    await runRound();
    await maybeSendWeeklyReport();

    const elapsed = Date.now() - roundStart;
    const sleepMs = Math.max(0, INTERVAL_H * 3_600_000 - elapsed);

    logger.info(`Ronda completada en ${(elapsed / 1000).toFixed(0)}s. Próxima en ${INTERVAL_H}h.`);
    await sleep(sleepMs);
  }
}

// ─── Una ronda: todos los combos símbolo × timeframe ─────────────────────────

async function runRound(): Promise<void> {
  // Resuelve los símbolos: override explícito del env, o top N de la DB (misma
  // lógica que el scanner real vía getTopSymbols → symbolVolume 7d).
  const symbols = SYMBOLS_OVERRIDE ?? await getTopSymbols();

  const combos = symbols.flatMap((symbol) =>
    TIMEFRAMES.map((timeframe) => ({ symbol, timeframe })),
  );

  logger.info(`Corriendo ${combos.length} combos (${symbols.length} símbolos × ${TIMEFRAMES.length} timeframes)`);

  for (const { symbol, timeframe } of combos) {
    try {
      await runOne(symbol, timeframe);
    } catch (err) {
      logger.error(`Error en ${symbol}/${timeframe}: ${(err as Error).message}`);
      // Continuamos con el siguiente combo — un fallo no para la ronda
    }
  }
}

// ─── Ejecutar un combo individual ────────────────────────────────────────────

async function runOne(symbol: string, timeframe: string): Promise<void> {
  logger.info(`→ ${symbol} ${timeframe}`);

  const cfg = defaultConfig(symbol, timeframe, {
    onlyBullish: ONLY_BULLISH,
    entryMode:   ENTRY_MODE,
    // Costos realistas para CoinEx taker
    feePctPerSide: 0.002,
    slippagePct:   0.0005,
    spreadPct:     0.0005,
    // Sin filtros extras → benchmark limpio del detector
    filters: {
      volumeWindow: 20,
      reentryEnabled: false,
      useCloseBasedSL: false,
    },
  });

  const result = await runBacktest(cfg);

  const ts    = Date.now();
  const runId = `${symbol}_${timeframe}_${isoStamp(ts)}`;

  const { mdPath } = writeReport(result, runId);

  logger.info(
    `  ✓ ${symbol}/${timeframe} → ${result.metrics.totalTrades} trades | ` +
    `${result.metrics.totalReturnPct.toFixed(2)}% | ` +
    `wolfes: ${result.wavesDetected} (filtradas: ${result.wavesFiltered}) | ` +
    `${mdPath}`,
  );

  // Guardar en historial de la semana
  weeklyHistory.push({ symbol, timeframe, runId, result, ts });

  // Mantener solo los últimos 14 días de historia en memoria para no crecer infinito
  const cutoff = Date.now() - 14 * 24 * 3_600_000;
  const trimIdx = weeklyHistory.findIndex((r) => r.ts >= cutoff);
  if (trimIdx > 0) weeklyHistory.splice(0, trimIdx);
}

// ─── Reporte semanal ──────────────────────────────────────────────────────────

async function maybeSendWeeklyReport(): Promise<void> {
  const SEVEN_DAYS = 7 * 24 * 3_600_000;
  if (Date.now() - lastWeeklyReportTs < SEVEN_DAYS) return;

  logger.info('Han pasado 7 días — enviando reporte semanal por Telegram…');

  try {
    // Tomar el run más reciente por combo para el resumen
    const latestByCombo = getLatestByCombo(weeklyHistory);
    await sendWeeklyReport(latestByCombo.map((r) => r.result));
    lastWeeklyReportTs = Date.now();
    logger.info('Reporte semanal enviado.');
  } catch (err) {
    logger.error(`Error enviando reporte semanal: ${(err as Error).message}`);
  }
}

function getLatestByCombo(records: RunRecord[]): RunRecord[] {
  const map = new Map<string, RunRecord>();
  for (const r of records) {
    const key = `${r.symbol}|${r.timeframe}`;
    const existing = map.get(key);
    if (!existing || r.ts > existing.ts) {
      map.set(key, r);
    }
  }
  return [...map.values()];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isoStamp(ts: number): string {
  return new Date(ts).toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

process.on('SIGINT',  () => { logger.info('SIGINT recibido — cerrando.'); process.exit(0); });
process.on('SIGTERM', () => { logger.info('SIGTERM recibido — cerrando.'); process.exit(0); });

main().catch((err) => {
  logger.error('batchRunner fallo fatal:', err);
  process.exit(1);
});

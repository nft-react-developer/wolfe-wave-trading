/**
 * weeklyReport.ts — Resumen semanal de backtests por Telegram
 *
 * Formatea los resultados de todos los combos símbolo×timeframe en un mensaje
 * y lo envía al chat configurado en TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID.
 *
 * El mensaje se envía como texto plano con formato Markdown (modo "MarkdownV2"
 * de Telegram), así que los caracteres especiales están correctamente escapados.
 */

import axios from 'axios';
import type { BacktestResult } from './types';
import { logger } from '../utils/logger';

// ─── Envío principal ──────────────────────────────────────────────────────────

export async function sendWeeklyReport(results: BacktestResult[]): Promise<void> {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    logger.warn('weeklyReport: TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID no configurados — saltando envío.');
    return;
  }

  const msg = buildMessage(results);

  await axios.post(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      chat_id:    chatId,
      text:       msg,
      parse_mode: 'HTML',
    },
    { timeout: 10_000 },
  );
}

// ─── Construcción del mensaje ─────────────────────────────────────────────────

function buildMessage(results: BacktestResult[]): string {
  const now  = new Date().toISOString().slice(0, 10);
  const week = getWeekLabel();

  const lines: string[] = [
    `📊 <b>Wolfe Wave Backtest — Resumen Semanal</b>`,
    `Semana: ${week}  |  Fecha: ${now}`,
    ``,
  ];

  if (results.length === 0) {
    lines.push('⚠️ Sin resultados disponibles esta semana.');
    return lines.join('\n');
  }

  // ── Tabla por combo ───────────────────────────────────────────────────────
  lines.push(`<b>Resultados por símbolo/timeframe</b>`);
  lines.push(`<code>`);
  lines.push(`${'Combo'.padEnd(16)} ${'Trades'.padStart(6)} ${'WR%'.padStart(6)} ${'Ret%'.padStart(7)} ${'Sortino'.padStart(8)} ${'Wolfes'.padStart(7)}`);
  lines.push(`${'─'.repeat(55)}`);

  // Ordenar: primero por símbolo, luego por timeframe
  const sorted = [...results].sort((a, b) => {
    const sc = a.symbol.localeCompare(b.symbol);
    return sc !== 0 ? sc : a.timeframe.localeCompare(b.timeframe);
  });

  for (const r of sorted) {
    const m      = r.metrics;
    const combo  = `${r.symbol}/${r.timeframe}`;
    const trades = String(m.totalTrades).padStart(6);
    const wr     = m.closedTrades > 0
      ? (m.winRate * 100).toFixed(0).padStart(5) + '%'
      : '  n/a';
    const ret    = m.totalReturnPct.toFixed(2).padStart(6) + '%';
    const sortino = m.sortino === 0 ? '     n/a' : m.sortino.toFixed(2).padStart(8);
    const wolfes = String(r.wavesDetected).padStart(7);

    lines.push(`${combo.padEnd(16)} ${trades} ${wr} ${ret} ${sortino} ${wolfes}`);
  }

  lines.push(`</code>`);
  lines.push('');

  // ── Destacados ────────────────────────────────────────────────────────────
  const withTrades = sorted.filter((r) => r.metrics.closedTrades > 0);

  if (withTrades.length > 0) {
    // Mejor retorno
    const best = withTrades.reduce((a, b) =>
      a.metrics.totalReturnPct > b.metrics.totalReturnPct ? a : b,
    );
    lines.push(`🏆 <b>Mejor retorno:</b> ${best.symbol}/${best.timeframe} → ${best.metrics.totalReturnPct.toFixed(2)}%`);

    // Mayor win rate
    const bestWR = withTrades.reduce((a, b) =>
      a.metrics.winRate > b.metrics.winRate ? a : b,
    );
    lines.push(`🎯 <b>Mayor win rate:</b> ${bestWR.symbol}/${bestWR.timeframe} → ${(bestWR.metrics.winRate * 100).toFixed(0)}%`);

    // Menor drawdown
    const leastDD = withTrades.reduce((a, b) =>
      a.metrics.maxDrawdownPct < b.metrics.maxDrawdownPct ? a : b,
    );
    lines.push(`🛡 <b>Menor drawdown:</b> ${leastDD.symbol}/${leastDD.timeframe} → ${leastDD.metrics.maxDrawdownPct.toFixed(2)}%`);

    lines.push('');
  } else {
    lines.push('ℹ️ Ningún combo cerró trades aún — el histórico se está acumulando.');
    lines.push('');
  }

  // ── Total wolfes detectadas ────────────────────────────────────────────────
  const totalWolfes   = results.reduce((s, r) => s + r.wavesDetected, 0);
  const totalFiltradas = results.reduce((s, r) => s + r.wavesFiltered, 0);
  const totalVelas    = results.reduce((s, r) => s + r.candleCount, 0);

  lines.push(`<b>Totales acumulados:</b>`);
  lines.push(`• Velas analizadas: ${totalVelas.toLocaleString()}`);
  lines.push(`• Wolfes detectadas: ${totalWolfes} (filtradas: ${totalFiltradas})`);
  lines.push(`• Combos activos: ${results.length}`);
  lines.push('');
  lines.push(`<i>El histórico crece con cada ronda — los resultados mejorarán a medida que se acumulen más datos.</i>`);

  return lines.join('\n');
}

// ─── Helper: etiqueta de semana ───────────────────────────────────────────────

function getWeekLabel(): string {
  const now  = new Date();
  const start = new Date(now);
  start.setDate(now.getDate() - now.getDay()); // Domingo anterior
  const end = new Date(start);
  end.setDate(start.getDate() + 6);

  const fmt = (d: Date) =>
    `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;

  return `${fmt(start)} → ${fmt(end)}`;
}

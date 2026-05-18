import fs from 'fs';
import path from 'path';
import type { BacktestResult, SimTrade } from './types';
import { buildEquityCurve } from './metrics';

// ─── Reporting ────────────────────────────────────────────────────────────────
//
// Genera dos archivos por corrida en `backtest/reports/<runId>/`:
//   - report.md    : resumen humano-readable
//   - trades.csv   : ledger de todos los trades para análisis externo

export function writeReport(
  result:  BacktestResult,
  runId:   string,
  baseDir = path.resolve(process.cwd(), 'backtest', 'reports'),
): { mdPath: string; csvPath: string } {
  const dir = path.join(baseDir, runId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const md = renderMarkdown(result);
  const csv = renderCsv(result.trades);

  const mdPath  = path.join(dir, 'report.md');
  const csvPath = path.join(dir, 'trades.csv');
  fs.writeFileSync(mdPath, md, 'utf8');
  fs.writeFileSync(csvPath, csv, 'utf8');

  // Tambien dejamos un equity_curve.csv que es útil para graficar fuera
  const eqPath = path.join(dir, 'equity_curve.csv');
  const equity = buildEquityCurve(result.trades, result.config.initialCapital);
  const eqCsv = ['ts,equity', ...equity.map((p) => `${p.ts},${p.equity.toFixed(2)}`)].join('\n');
  fs.writeFileSync(eqPath, eqCsv, 'utf8');

  return { mdPath, csvPath };
}

// ─── Markdown ─────────────────────────────────────────────────────────────────

function renderMarkdown(r: BacktestResult): string {
  const { config: c, metrics: m } = r;
  const pct = (n: number) => `${n.toFixed(2)}%`;
  const $ = (n: number) => `$${n.toFixed(2)}`;
  const f = (n: number, d = 2) => n.toFixed(d);

  const lines: string[] = [];
  lines.push(`# Backtest Report — ${c.symbol} ${c.timeframe}`);
  lines.push('');
  lines.push(`Periodo: ${new Date(r.fromTs).toISOString().slice(0, 10)} → ${new Date(r.toTs).toISOString().slice(0, 10)}`);
  lines.push(`Velas analizadas: ${r.candleCount}`);
  lines.push(`Solo bullish: ${c.onlyBullish}`);
  lines.push('');

  // ── Resultados principales ───────────────────────────────────────────────────
  lines.push('## Resultado');
  lines.push('');
  lines.push('| Métrica | Valor |');
  lines.push('|---|---|');
  lines.push(`| Capital inicial | ${$(c.initialCapital)} |`);
  lines.push(`| Capital final | ${$(m.finalEquity)} |`);
  lines.push(`| Retorno total | ${pct(m.totalReturnPct)} |`);
  lines.push(`| CAGR | ${pct(m.cagr)} |`);
  lines.push(`| Max Drawdown | ${pct(m.maxDrawdownPct)} (${$(m.maxDrawdownAbs)}) |`);
  lines.push(`| Sharpe (anual) | ${f(m.sharpe)} |`);
  lines.push(`| Sortino (anual) | ${f(m.sortino)} |`);
  lines.push(`| Calmar | ${f(m.calmar)} |`);
  lines.push(`| Profit Factor | ${m.profitFactor === Infinity ? '∞' : f(m.profitFactor)} |`);
  lines.push(`| Win Rate | ${pct(m.winRate * 100)} |`);
  lines.push(`| Expectancy (R) | ${f(m.expectancy, 3)} |`);
  lines.push(`| Expectancy ($) | ${$(m.expectancyUsd)} |`);
  lines.push(`| Avg Win (R) | ${f(m.avgWinR, 3)} |`);
  lines.push(`| Avg Loss (R) | ${f(m.avgLossR, 3)} |`);
  lines.push(`| Avg RR realizado | ${f(m.avgRrRealized, 2)} |`);
  lines.push(`| Trades totales | ${m.totalTrades} |`);
  lines.push(`| Trades cerrados | ${m.closedTrades} |`);
  lines.push(`| Trades/mes | ${f(m.tradesPerMonth, 1)} |`);
  lines.push(`| Velas en trade (prom) | ${f(m.avgCandlesInTrade, 1)} |`);
  lines.push(`| Wolfes detectadas | ${r.wavesDetected} |`);
  lines.push(`| Wolfes filtradas | ${r.wavesFiltered} |`);
  lines.push('');

  // ── Configuración usada ─────────────────────────────────────────────────────
  lines.push('## Configuración');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(c, null, 2));
  lines.push('```');
  lines.push('');

  // ── Por forma ───────────────────────────────────────────────────────────────
  if (Object.keys(m.byShape).length > 0) {
    lines.push('## Por forma de la onda');
    lines.push('');
    lines.push('| Shape | Trades | Win Rate | Avg R | Total PnL |');
    lines.push('|---|---|---|---|---|');
    for (const [shape, b] of Object.entries(m.byShape)) {
      lines.push(`| ${shape} | ${b.trades} | ${pct(b.winRate * 100)} | ${f(b.avgR, 3)} | ${$(b.totalPnl)} |`);
    }
    lines.push('');
  }

  // ── Razones de cierre ───────────────────────────────────────────────────────
  if (Object.keys(m.byCloseReason).length > 0) {
    lines.push('## Razones de cierre');
    lines.push('');
    lines.push('| Razón | Trades |');
    lines.push('|---|---|');
    for (const [k, v] of Object.entries(m.byCloseReason)) {
      lines.push(`| ${k} | ${v} |`);
    }
    lines.push('');
  }

  // ── Por mes ─────────────────────────────────────────────────────────────────
  if (m.byMonth.length > 0) {
    lines.push('## PnL mensual');
    lines.push('');
    lines.push('| Mes | Trades | PnL |');
    lines.push('|---|---|---|');
    for (const b of m.byMonth) {
      lines.push(`| ${b.month} | ${b.trades} | ${$(b.pnl)} |`);
    }
    lines.push('');
  }

  // ── Distribución de R-multiples (texto) ─────────────────────────────────────
  lines.push('## Distribución de R-multiples');
  lines.push('');
  const closed = r.trades.filter((t) => t.exitIdx !== undefined);
  const rs = closed.map((t) => t.rMultiple ?? 0);
  if (rs.length > 0) {
    lines.push(renderRHistogram(rs));
  } else {
    lines.push('_(sin trades cerrados)_');
  }
  lines.push('');

  return lines.join('\n');
}

// Histograma ascii de R-multiples para incluir en el MD
function renderRHistogram(rs: number[]): string {
  const bins = [-3, -2, -1, -0.5, 0, 0.5, 1, 2, 3, 5, 10];
  const counts = new Array(bins.length - 1).fill(0);
  for (const r of rs) {
    for (let i = 0; i < bins.length - 1; i++) {
      if (r >= bins[i] && r < bins[i + 1]) {
        counts[i]++;
        break;
      }
    }
  }
  const max = Math.max(...counts, 1);
  const out: string[] = [];
  out.push('```');
  for (let i = 0; i < counts.length; i++) {
    const label = `[${bins[i].toString().padStart(5)} → ${bins[i + 1].toString().padEnd(5)}]`;
    const bar = '█'.repeat(Math.round((counts[i] / max) * 30));
    out.push(`${label} ${counts[i].toString().padStart(4)} ${bar}`);
  }
  out.push('```');
  return out.join('\n');
}

// ─── CSV ──────────────────────────────────────────────────────────────────────

function renderCsv(trades: SimTrade[]): string {
  const headers = [
    'id', 'symbol', 'timeframe', 'direction', 'shape',
    'entryTime', 'exitTime', 'entryPrice', 'exitPrice',
    'stopLoss', 'target1', 'target2',
    'quantity', 'usdAmount',
    'netPnl', 'netPnlPct', 'rMultiple',
    'mfe', 'mae',
    'closeReason', 'candlesInTrade',
    'hitTp1', 'hitTp2', 'hitTp3', 'hitTp4',
    'p5VolRatio', 'hasMacdDiv', 'brokeEMA50',
    'reentryNumber',
  ];

  const escape = (v: unknown): string => {
    if (v === undefined || v === null) return '';
    const s = String(v);
    return s.includes(',') ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const rows: string[] = [headers.join(',')];
  for (const t of trades) {
    rows.push([
      t.id,
      t.symbol,
      t.timeframe,
      t.direction,
      t.shape,
      t.entryTime ? new Date(t.entryTime).toISOString() : '',
      t.exitTime  ? new Date(t.exitTime).toISOString()  : '',
      t.entryPrice?.toFixed(8),
      t.exitPrice?.toFixed(8),
      t.stopLoss?.toFixed(8),
      t.target1?.toFixed(8),
      t.target2?.toFixed(8),
      t.quantity?.toFixed(8),
      t.usdAmount?.toFixed(2),
      t.netPnl?.toFixed(4),
      t.netPnlPct?.toFixed(4),
      t.rMultiple?.toFixed(4),
      t.mfe?.toFixed(3),
      t.mae?.toFixed(3),
      t.closeReason,
      t.candlesInTrade,
      t.hitTp1,
      t.hitTp2,
      t.hitTp3,
      t.hitTp4,
      t.p5VolRatio?.toFixed(2),
      t.hasMacdDiv,
      t.brokeEMA50,
      t.reentryNumber,
    ].map(escape).join(','));
  }
  return rows.join('\n');
}

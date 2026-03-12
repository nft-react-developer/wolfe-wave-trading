import TelegramBot from 'node-telegram-bot-api';
import { logger } from '../utils/logger';

let bot: TelegramBot | null = null;
const chatId = process.env.TELEGRAM_CHAT_ID ?? '';

function getBot(): TelegramBot | null {
  if (!process.env.TELEGRAM_BOT_TOKEN) return null;

  if (!bot) {
    bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: false });
  }
  return bot;
}

async function send(message: string): Promise<void> {
  const b = getBot();
  if (!b || !chatId) {
    logger.debug('Telegram not configured, skipping notification');
    return;
  }

  try {
    await b.sendMessage(chatId, message, { parse_mode: 'HTML' });
  } catch (err) {
    logger.error('Telegram send failed', err);
  }
}

// ─── Notification templates ───────────────────────────────────────────────────

export const telegram = {
  async notifyWaveDetected(wave: {
    symbol: string;
    timeframe: string;
    direction: string;
    shape: string;
    isPerfect: boolean;
    entryPrice: number;
    stopLoss: number;
    target1: number;
    target2: number;
    target3?: number;
    ema50: number;
  }) {
    const emoji = wave.direction === 'bullish' ? '🟢' : '🔴';
    const mode = process.env.TRADING_MODE ?? 'paper';
    const modeTag = mode === 'paper' ? '📝 PAPER' : '💰 REAL';

    const msg = `
${emoji} <b>Wolfe Wave Detected</b> [${modeTag}]

<b>Symbol:</b> ${wave.symbol}
<b>Timeframe:</b> ${wave.timeframe}
<b>Direction:</b> ${wave.direction.toUpperCase()}
<b>Shape:</b> ${wave.shape}${wave.isPerfect ? ' ✅ PERFECT' : ''}

<b>Entry:</b> ${wave.entryPrice.toFixed(6)}
<b>Stop Loss:</b> ${wave.stopLoss.toFixed(6)}
<b>Target 1 (23.6%):</b> ${wave.target1.toFixed(6)}
<b>Target 2 (61.8%):</b> ${wave.target2.toFixed(6)}${wave.target3 ? `\n<b>Target 3 (100%):</b> ${wave.target3.toFixed(6)}` : ''}

<b>EMA50:</b> ${wave.ema50.toFixed(6)}
`.trim();

    await send(msg);
  },

  async notifyTradeOpened(trade: {
    id?: number;
    symbol: string;
    side: string;
    entryPrice: number;
    stopLoss: number;
    target1: number;
    target2: number;
    usdAmount: number;
    quantity: number;
    mode: string;
  }) {
    const emoji = trade.side === 'long' ? '📈' : '📉';
    const modeTag = trade.mode === 'paper' ? '📝 PAPER' : '💰 REAL';

    const msg = `
${emoji} <b>Trade Opened</b> [${modeTag}] #${trade.id}

<b>Symbol:</b> ${trade.symbol}
<b>Side:</b> ${trade.side.toUpperCase()}
<b>Entry:</b> ${trade.entryPrice.toFixed(6)}
<b>Qty:</b> ${trade.quantity.toFixed(6)} ($${trade.usdAmount.toFixed(2)})
<b>Stop:</b> ${trade.stopLoss.toFixed(6)}
<b>TP1:</b> ${trade.target1.toFixed(6)}
<b>TP2:</b> ${trade.target2.toFixed(6)}
`.trim();

    await send(msg);
  },

  async notifyTradeClosed(trade: {
    id?: number;
    symbol: string;
    side: string;
    entryPrice: number;
    exitPrice: number;
    pnl: number;
    pnlPct: number;
    closeReason: string;
    mode: string;
  }) {
    const won = trade.pnl >= 0;
    const emoji = won ? '✅' : '❌';
    const modeTag = trade.mode === 'paper' ? '📝 PAPER' : '💰 REAL';

    const msg = `
${emoji} <b>Trade Closed</b> [${modeTag}] #${trade.id}

<b>Symbol:</b> ${trade.symbol}
<b>Side:</b> ${trade.side.toUpperCase()}
<b>Entry:</b> ${trade.entryPrice.toFixed(6)} → <b>Exit:</b> ${trade.exitPrice.toFixed(6)}
<b>Reason:</b> ${trade.closeReason.toUpperCase()}
<b>PnL:</b> ${won ? '+' : ''}$${trade.pnl.toFixed(2)} (${trade.pnlPct.toFixed(2)}%)
`.trim();

    await send(msg);
  },

  async sendDailyReport(report: {
    date: string;
    mode: string;
    tradesOpened: number;
    tradesClosed: number;
    dailyPnl: number;
    cumulativePnl: number;
    winRate: number;
    openPositions: number;
    balance: number;
    wavesDetected: number;
  }) {
    const modeTag = report.mode === 'paper' ? '📝 PAPER' : '💰 REAL';
    const pnlEmoji = report.dailyPnl >= 0 ? '🟢' : '🔴';
    const cPnlEmoji = report.cumulativePnl >= 0 ? '🟢' : '🔴';

    const msg = `
📊 <b>Daily Trading Report</b> [${modeTag}]
📅 <b>Date:</b> ${report.date}

<b>Waves Detected:</b> ${report.wavesDetected}
<b>Trades Opened:</b> ${report.tradesOpened}
<b>Trades Closed:</b> ${report.tradesClosed}
<b>Open Positions:</b> ${report.openPositions}

${pnlEmoji} <b>Daily PnL:</b> ${report.dailyPnl >= 0 ? '+' : ''}$${report.dailyPnl.toFixed(2)}
${cPnlEmoji} <b>Cumulative PnL:</b> ${report.cumulativePnl >= 0 ? '+' : ''}$${report.cumulativePnl.toFixed(2)}
<b>Win Rate:</b> ${report.winRate.toFixed(1)}%
<b>Balance:</b> $${report.balance.toFixed(2)}
`.trim();

    await send(msg);
  },

  async sendRaw(message: string) {
    await send(message);
  },
};

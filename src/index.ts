import 'dotenv/config';
import { getDb, closeDb } from './db/connection';
import { config } from './utils/config';
import { logger } from './utils/logger';
import { CoinExExchange, PaperExchange } from './services/exchange';
import { Scanner } from './services/scanner';
import { PollingPriceFeed, WebSocketPriceFeed } from './services/priceFeed';
import { createApp } from './api/routes';
import { startDailyReportScheduler } from './services/scheduler';
import type { IExchange } from './types';

// ─── Graceful shutdown ────────────────────────────────────────────────────────

let scanner: Scanner | null = null;

async function shutdown(signal: string) {
  logger.info(`Received ${signal}, shutting down...`);
  scanner?.stop();
  await closeDb();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', err);
  void shutdown('uncaughtException');
});

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function main() {
  logger.info('=== Wolfe Wave Trading System ===');
  logger.info(`Mode: ${config.tradingMode.toUpperCase()}`);
  logger.info(`Initial Capital: $${config.initialCapital}`);
  logger.info(`Max Trade Amount: $${config.maxTradeAmount}`);
  logger.info(`Symbols: ${config.scanSymbols.join(', ')}`);
  logger.info(`Timeframes: ${config.scanTimeframes.join(', ')}`);

  // ─── Database connection ──────────────────────────────────────────────

  logger.info('Connecting to database...');
  await getDb();
  logger.info('Database connected');

  // ─── Exchange ─────────────────────────────────────────────────────────

  let exchange: IExchange;
  if (config.tradingMode === 'paper') {
    exchange = new PaperExchange(config.initialCapital);
    logger.info('Using Paper Exchange (simulated trading)');
  } else {
    exchange = new CoinExExchange();
    logger.info('Using CoinEx Live Exchange');
  }

  // ─── Scanner ──────────────────────────────────────────────────────────

  const priceFeed = config.priceFeed === 'websocket'
    ? new WebSocketPriceFeed()
    : new PollingPriceFeed();

  scanner = new Scanner(exchange, priceFeed);
  scanner.start();

  // ─── Daily report scheduler ───────────────────────────────────────────

  startDailyReportScheduler();

  // ─── REST API ─────────────────────────────────────────────────────────

  const app = createApp(exchange, scanner);
  const port = config.apiPort;

  app.listen(port, () => {
    logger.info(`API server running on http://localhost:${port}`);
    logger.info(`Endpoints:`);
    logger.info(`  GET /api/health`);
    logger.info(`  GET /api/waves`);
    logger.info(`  GET /api/waves/:id`);
    logger.info(`  GET /api/waves/stats/summary`);
    logger.info(`  GET /api/trades`);
    logger.info(`  GET /api/trades/:id`);
    logger.info(`  GET /api/trades/open`);
    logger.info(`  GET /api/trades/stats/summary`);
    logger.info(`  GET /api/stats/daily`);
    logger.info(`  GET /api/stats/today`);
    logger.info(`  GET /api/stats/performance`);
    logger.info(`  GET /api/stats/pnl-by-period`);
    logger.info(`  GET /api/account/balance`);
    logger.info(`  GET /api/bot/status`);
    logger.info(`  POST /api/bot/pause`);
    logger.info(`  POST /api/bot/resume`);
    logger.info(`  PATCH /api/config`);
    logger.info(`Price feed: ${config.priceFeed.toUpperCase()}`);
  });
}

main().catch((err) => {
  logger.error('Fatal startup error', err);
  process.exit(1);
});
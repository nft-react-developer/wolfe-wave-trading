import express from 'express';
import { getWaveStats, getTradeStats, generateDailyReport, getEquityCurve } from '../services/statistics';
import { getDb, schema } from '../db/connection';
import { eq, and, desc, gte, lte } from 'drizzle-orm';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import type { TradeMode, IExchange } from '../types';
import type { Scanner } from '../services/scanner';

const { wolfeWaves, trades, accountSnapshots } = schema;

export function createRouter(exchange: IExchange, scanner: Scanner) {
  const router = express.Router();

  // ─── Health ───────────────────────────────────────────────────────────────

  router.get('/health', (_req, res) => {
    res.json({ status: 'ok', mode: config.tradingMode, timestamp: new Date().toISOString() });
  });

  // ─── Wave endpoints ───────────────────────────────────────────────────────

  /**
   * GET /api/waves
   * Query: symbol, timeframe, direction, shape, from, to, limit, offset
   */
  router.get('/waves', async (req, res) => {
    try {
      const db = await getDb();
      const { symbol, timeframe, direction, shape, from, to, limit = '50', offset = '0' } = req.query as Record<string, string>;

      const conditions: ReturnType<typeof eq>[] = [];
      if (symbol) conditions.push(eq(wolfeWaves.symbol, symbol));
      if (timeframe) conditions.push(eq(wolfeWaves.timeframe, timeframe));
      if (direction) conditions.push(eq(wolfeWaves.direction, direction as 'bullish' | 'bearish'));
      if (shape) conditions.push(eq(wolfeWaves.shape, shape as 'perfect' | 'fat_mw' | 'long_neck' | 'imperfect'));
      if (from) conditions.push(gte(wolfeWaves.detectedAt, new Date(from).getTime()));
      if (to) conditions.push(lte(wolfeWaves.detectedAt, new Date(to).getTime()));

      const rows = await db.select().from(wolfeWaves)
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(wolfeWaves.detectedAt))
        .limit(Number(limit))
        .offset(Number(offset));

      res.json({ data: rows, count: rows.length });
    } catch (err) {
      logger.error('GET /waves error', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * GET /api/waves/:id
   */
  router.get('/waves/:id', async (req, res) => {
    try {
      const db = await getDb();
      const [wave] = await db.select().from(wolfeWaves).where(eq(wolfeWaves.id, Number(req.params.id)));
      if (!wave) return res.status(404).json({ error: 'Wave not found' });

      // Include associated trades
      const waveTrades = await db.select().from(trades).where(eq(trades.wolfeWaveId, wave.id!));
      res.json({ data: wave, trades: waveTrades });
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * GET /api/waves/stats/summary
   * Query: symbol, timeframe, from, to
   */
  router.get('/waves/stats/summary', async (req, res) => {
    try {
      const { symbol, timeframe, from, to } = req.query as Record<string, string>;
      const stats = await getWaveStats({
        symbol,
        timeframe,
        fromDate: from ? new Date(from) : undefined,
        toDate: to ? new Date(to) : undefined,
      });
      res.json({ data: stats });
    } catch (err) {
      logger.error('GET /waves/stats/summary error', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ─── Trade endpoints ──────────────────────────────────────────────────────

  /**
   * GET /api/trades
   * Query: mode, status, symbol, timeframe, from, to, limit, offset
   */
  router.get('/trades', async (req, res) => {
    try {
      const db = await getDb();
      const {
        mode = config.tradingMode,
        status, symbol, timeframe,
        from, to, limit = '50', offset = '0',
      } = req.query as Record<string, string>;

      const conditions = [eq(trades.mode, mode as TradeMode)];
      if (status) conditions.push(eq(trades.status, status as 'open' | 'closed' | 'cancelled'));
      if (symbol) conditions.push(eq(trades.symbol, symbol));
      if (timeframe) conditions.push(eq(trades.timeframe, timeframe));
      if (from) conditions.push(gte(trades.entryTime, new Date(from).getTime()));
      if (to) conditions.push(lte(trades.entryTime, new Date(to).getTime()));

      const rows = await db.select().from(trades)
        .where(and(...conditions))
        .orderBy(desc(trades.entryTime))
        .limit(Number(limit))
        .offset(Number(offset));

      res.json({ data: rows, count: rows.length });
    } catch (err) {
      logger.error('GET /trades error', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * GET /api/trades/:id
   */
  router.get('/trades/:id', async (req, res) => {
    try {
      const db = await getDb();
      const [trade] = await db.select().from(trades).where(eq(trades.id, Number(req.params.id)));
      if (!trade) return res.status(404).json({ error: 'Trade not found' });

      const [wave] = await db.select().from(wolfeWaves).where(eq(wolfeWaves.id, trade.wolfeWaveId));
      res.json({ data: trade, wave });
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * GET /api/trades/stats/summary
   * Query: mode, symbol, timeframe, from, to
   */
  router.get('/trades/stats/summary', async (req, res) => {
    try {
      const { mode = config.tradingMode, symbol, timeframe, from, to } = req.query as Record<string, string>;
      const stats = await getTradeStats(mode as TradeMode, {
        symbol, timeframe,
        fromDate: from ? new Date(from) : undefined,
        toDate: to ? new Date(to) : undefined,
      });
      res.json({ data: stats });
    } catch (err) {
      logger.error('GET /trades/stats/summary error', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * GET /api/trades/open
   */
  router.get('/trades/open', async (req, res) => {
    try {
      const db = await getDb();
      const { mode = config.tradingMode } = req.query as Record<string, string>;

      const rows = await db.select().from(trades).where(
        and(eq(trades.mode, mode as TradeMode), eq(trades.status, 'open'))
      ).orderBy(desc(trades.entryTime));

      res.json({ data: rows, count: rows.length });
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ─── Statistics endpoints ─────────────────────────────────────────────────

  /**
   * GET /api/stats/daily?mode=paper&days=30
   */
  router.get('/stats/daily', async (req, res) => {
    try {
      const { mode = config.tradingMode, days = '30' } = req.query as Record<string, string>;
      const data = await getEquityCurve(mode as TradeMode, Number(days));
      res.json({ data });
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * GET /api/stats/today?mode=paper
   */
  router.get('/stats/today', async (req, res) => {
    try {
      const { mode = config.tradingMode } = req.query as Record<string, string>;
      const report = await generateDailyReport(mode as TradeMode);
      res.json({ data: report });
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * GET /api/stats/performance?mode=paper
   * Combined wave + trade stats
   */
  router.get('/stats/performance', async (req, res) => {
    try {
      const { mode = config.tradingMode, symbol, timeframe, from, to } = req.query as Record<string, string>;

      const [waveStats, tradeStats] = await Promise.all([
        getWaveStats({
          symbol, timeframe,
          fromDate: from ? new Date(from) : undefined,
          toDate: to ? new Date(to) : undefined,
        }),
        getTradeStats(mode as TradeMode, {
          symbol, timeframe,
          fromDate: from ? new Date(from) : undefined,
          toDate: to ? new Date(to) : undefined,
        }),
      ]);

      const initialCapital = config.initialCapital;
      const balance = initialCapital + tradeStats.totalPnl;
      const roi = ((balance - initialCapital) / initialCapital) * 100;

      res.json({
        data: {
          mode,
          initialCapital,
          currentBalance: balance,
          roi,
          waves: waveStats,
          trades: tradeStats,
          config: {
            maxTradeAmount: config.maxTradeAmount,
            maxTradePct: config.maxTradePct,
            symbols: config.scanSymbols,
            timeframes: config.scanTimeframes,
          },
        },
      });
    } catch (err) {
      logger.error('GET /stats/performance error', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  /**
   * GET /api/stats/pnl-by-period?mode=paper&groupBy=day|week|month
   */
  router.get('/stats/pnl-by-period', async (req, res) => {
    try {
      const db = await getDb();
      const { mode = config.tradingMode } = req.query as Record<string, string>;

      // Get all closed trades for the mode
      const allTrades = await db.select({
        exitTime: trades.exitTime,
        pnl: trades.pnl,
        symbol: trades.symbol,
      }).from(trades).where(
        and(eq(trades.mode, mode as TradeMode), eq(trades.status, 'closed'))
      ).orderBy(trades.exitTime);

      // Group by day
      const byDay: Record<string, { pnl: number; count: number; wins: number }> = {};
      for (const t of allTrades) {
        if (!t.exitTime) continue;
        const day = new Date(Number(t.exitTime)).toISOString().split('T')[0];
        if (!byDay[day]) byDay[day] = { pnl: 0, count: 0, wins: 0 };
        byDay[day].pnl += Number(t.pnl ?? 0);
        byDay[day].count++;
        if (Number(t.pnl) >= 0) byDay[day].wins++;
      }

      const periods = Object.entries(byDay).map(([date, data]) => ({
        date,
        pnl: data.pnl,
        trades: data.count,
        winRate: data.count > 0 ? (data.wins / data.count) * 100 : 0,
      }));

      res.json({ data: periods });
    } catch (err) {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ─── Account balance ──────────────────────────────────────────────────────

  /**
   * GET /api/account/balance
   * Returns available balances from the exchange (real or paper).
   */
  router.get('/account/balance', async (_req, res) => {
    try {
      const balances = await exchange.getBalance();
      res.json({ exchange: exchange.getName(), data: balances });
    } catch (err) {
      logger.error('GET /account/balance error', err);
      res.status(500).json({ error: 'Failed to fetch balance' });
    }
  });

  // ─── Bot control ─────────────────────────────────────────────────────────

  /**
   * POST /api/bot/pause
   * Manually pause new trade detection (open trades keep being monitored).
   */
  router.post('/bot/pause', (_req, res) => {
    scanner.pause();
    res.json({ paused: true });
  });

  /**
   * POST /api/bot/resume
   * Resume new trade detection after a manual or automatic pause.
   */
  router.post('/bot/resume', (_req, res) => {
    scanner.resume();
    res.json({ paused: false });
  });

  /**
   * GET /api/bot/status
   */
  router.get('/bot/status', (_req, res) => {
    res.json({
      paused: scanner.isPaused(),
      mode:   config.tradingMode,
      config: {
        maxTradeAmount:        config.maxTradeAmount,
        maxTradePct:           config.maxTradePct,
        maxOpenTradesTotal:    config.maxOpenTradesTotal,
        maxOpenTradesPerSymbol: config.maxOpenTradesPerSymbol,
        maxDailyLossPct:       config.maxDailyLossPct,
      },
    });
  });

  // ─── Config ───────────────────────────────────────────────────────────────

  /**
   * PATCH /api/config
   * Hot-update runtime config values without restarting the process.
   * Accepted fields: maxTradeAmount, maxTradePct, maxOpenTradesTotal,
   *                  maxOpenTradesPerSymbol, maxDailyLossPct
   * Changes are lost on restart (not persisted to .env).
   */
  router.patch('/config', (req, res) => {
    const allowed = [
      'maxTradeAmount',
      'maxTradePct',
      'maxOpenTradesTotal',
      'maxOpenTradesPerSymbol',
      'maxDailyLossPct',
    ] as const;

    const updated: Record<string, number> = {};
    const rejected: Record<string, string> = {};

    for (const key of allowed) {
      const val = req.body[key];
      if (val === undefined) continue;
      const num = Number(val);
      if (isNaN(num) || num < 0) {
        rejected[key] = 'must be a non-negative number';
        continue;
      }
      (config as Record<string, unknown>)[key] = num;
      updated[key] = num;
    }

    const unknownKeys = Object.keys(req.body).filter(
      (k) => !(allowed as readonly string[]).includes(k)
    );
    for (const k of unknownKeys) rejected[k] = 'field not allowed';

    logger.info('Config updated via API', updated);
    res.json({ updated, rejected });
  });

  return router;
}

export function createApp(exchange: IExchange, scanner: Scanner) {
  const app = express();
  app.use(express.json());

  const router = createRouter(exchange, scanner);
  app.use('/api', router);

  // 404 handler
  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  return app;
}
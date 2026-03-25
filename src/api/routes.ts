import express from 'express';
import { getWaveStats, getTradeStats, generateDailyReport, getEquityCurve } from '../services/statistics';
import { getDb, schema } from '../db/connection';
import { eq, and, desc, gte, lte } from 'drizzle-orm';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import type { TradeMode, IExchange } from '../types';
import type { Scanner } from '../services/scanner';
import { telegram } from '../services/telegram';


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

      res.json({ count: rows.length,data: rows });
    } catch (err) {
      res.status(500).json({ error: 'Internal server error', err }, );
    }
  });

  /**
 * POST /api/trades/close-all
 * Cierra todas las posiciones abiertas con órdenes de venta a mercado.
 */
router.post('/trades/close-all', async (_req, res) => {
  try {
    const db = await getDb();

    const openTrades = await db
      .select()
      .from(trades)
      .where(and(eq(trades.status, 'open'), eq(trades.mode, config.tradingMode)));

    if (openTrades.length === 0) {
      return res.json({ closed: 0, results: [] });
    }

    const results = [];

    for (const trade of openTrades) {
      try {
        const isLong   = trade.side === 'long';
        const qty      = Number(trade.quantity)
          - Number(trade.closedQty1)
          - Number(trade.closedQty2)
          - Number(trade.closedQty3)
          - Number(trade.closedQty4);

        // Obtener precio actual
        const candles = await exchange.getCandles(trade.symbol, '1min', 1);
        const currentPrice = candles[candles.length - 1]?.close ?? Number(trade.entryPrice);

        // Ejecutar venta a mercado en modo real
        if (config.tradingMode === 'real') {
          // Cancelar SL pendiente si existe
          if (trade.slOrderId) {
            try {
              await exchange.cancelOrder(trade.symbol, trade.slOrderId);
            } catch (err) {
              logger.warn(`close-all: could not cancel SL order for trade #${trade.id}`, err);
            }
          }

          await exchange.placeOrder({
            symbol:   trade.symbol,
            side:     isLong ? 'sell' : 'buy',
            type:     'market',
            quantity: qty,
            price:    currentPrice,
          });
        }

        // Calcular PnL y cerrar en DB
        const entry  = Number(trade.entryPrice);
        const pnl    = isLong
          ? (currentPrice - entry) * qty
          : (entry - currentPrice) * qty;
        const pnlPct = (pnl / Number(trade.usdAmount)) * 100;

        await db.update(trades).set({
          status:      'closed',
          exitPrice:   currentPrice.toFixed(8),
          exitTime:    Date.now(),
          closeReason: 'manual',
          pnl:         pnl.toFixed(2),
          pnlPct:      pnlPct.toFixed(4),
        }).where(eq(trades.id, trade.id!));

        logger.info(`close-all: trade #${trade.id} closed`, {
          symbol: trade.symbol,
          price:  currentPrice,
          pnl:    pnl.toFixed(2),
        });

        results.push({ id: trade.id, symbol: trade.symbol, pnl: Number(pnl.toFixed(2)), status: 'closed' });
      } catch (err) {
        logger.error(`close-all: failed to close trade #${trade.id}`, err);
        results.push({ id: trade.id, symbol: trade.symbol, status: 'error' });
      }
    }

    res.json({
      closed:  results.filter(r => r.status === 'closed').length,
      errors:  results.filter(r => r.status === 'error').length,
      results,
    });
  } catch (err) {
    logger.error('POST /trades/close-all error', err);
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
      // En modo real obtenemos el balance directamente del exchange
      let currentBalance: number;
      if (config.tradingMode === 'real') {
        try {
          const balances = await exchange.getBalance();
          currentBalance = balances['USDT'] ?? 0;
        } catch {
          currentBalance = initialCapital + tradeStats.totalPnl;
        }
      } else {
        currentBalance = initialCapital + tradeStats.totalPnl;
      }

      const roi = ((currentBalance - initialCapital) / initialCapital) * 100;

      res.json({
        data: {
          mode,
          bot: {
            active: !scanner.isPaused(),
          },
          initialCapital,
          currentBalance: currentBalance,
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

    // Convertir cada moneda a USD usando el último precio de CoinEx
    let totalUsd = 0;
    const usdValues: Record<string, number> = {};

    for (const [ccy, amount] of Object.entries(balances)) {
      if (amount <= 0) continue;

      if (ccy === 'USDT' || ccy === 'USDC' || ccy === 'BUSD') {
        // Stablecoins = 1:1 con USD
        usdValues[ccy] = amount;
        totalUsd += amount;
      } else {
        // Obtener precio via último candle del par CCY/USDT
        try {
          const candles = await exchange.getCandles(`${ccy}USDT`, '1min', 1);
          if (candles.length > 0) {
            const price = candles[candles.length - 1].close;
            const usd = amount * price;
            usdValues[ccy] = usd;
            totalUsd += usd;
          } else {
            usdValues[ccy] = 0;
          }
        } catch {
          usdValues[ccy] = 0;
        }
      }
    }

    res.json({
      exchange: exchange.getName(),
      data: balances,
      totalUsd: Number(totalUsd.toFixed(2)),
    });
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
      paused:  scanner.isPaused(),
      mode:    config.tradingMode,
      symbols: config.scanSymbols,
      config: {
        maxTradeAmount:         config.maxTradeAmount,
        maxTradePct:            config.maxTradePct,
        maxOpenTradesTotal:     config.maxOpenTradesTotal,
        maxOpenTradesPerSymbol: config.maxOpenTradesPerSymbol,
        maxDailyLossPct:        config.maxDailyLossPct,
      },
    });
  });

  /**
 * GET /api/test/wave-chart?waveId=123
 * Genera el chart del último wave detectado (o del waveId indicado)
 * y manda la notificación de Telegram con imagen.
 * Solo para pruebas — eliminar o proteger en producción.
 */
router.get('/test/wave-chart', async (req, res) => {
  try {
    const db = await getDb();

    // Usar waveId de query param, o tomar el más reciente
    let wave;
    if (req.query.waveId) {
      [wave] = await db.select().from(wolfeWaves)
        .where(eq(wolfeWaves.id, Number(req.query.waveId)));
    } else {
      [wave] = await db.select().from(wolfeWaves)
        .orderBy(desc(wolfeWaves.detectedAt))
        .limit(1);
    }

    if (!wave) {
      return res.status(404).json({ error: 'No waves found in DB' });
    }

    // Buscar las velas desde el exchange
    const candles = await exchange.getCandles(wave.symbol, wave.timeframe, 200);
    if (candles.length === 0) {
      return res.status(500).json({ error: 'Could not fetch candles from exchange' });
    }

    // Reconstruir el objeto WolfeWave desde la fila de BD
    const waveObj: import('../types').WolfeWave = {
      id:         wave.id,
      symbol:     wave.symbol,
      timeframe:  wave.timeframe,
      direction:  wave.direction,
      p1: { index: wave.p1Index, price: Number(wave.p1Price), timestamp: wave.p1Time },
      p2: { index: wave.p2Index, price: Number(wave.p2Price), timestamp: wave.p2Time },
      p3: { index: wave.p3Index, price: Number(wave.p3Price), timestamp: wave.p3Time },
      p4: { index: wave.p4Index, price: Number(wave.p4Price), timestamp: wave.p4Time },
      p5: { index: wave.p5Index, price: Number(wave.p5Price), timestamp: wave.p5Time },
      isPerfect:     wave.isPerfect,
      shape:         wave.shape,
      isDoubleWolfe: wave.isDoubleWolfe,
      entryPrice:    Number(wave.entryPrice),
      stopLoss:      Number(wave.stopLoss),
      target1:       Number(wave.target1),
      target2:       Number(wave.target2),
      target3:       wave.target3 ? Number(wave.target3) : undefined,
      target4:       wave.target4 ? Number(wave.target4) : undefined,
      line14Price:   wave.line14Price ? Number(wave.line14Price) : undefined,
      ema50:         Number(wave.ema50),
      macdHistogram: wave.macdHistogram ? Number(wave.macdHistogram) : undefined,
      detectedAt:    wave.detectedAt,
    };

    // Generar chart
    const { generateWaveChart } = await import('../utils/chartRenderer');
    const chartImage = await generateWaveChart({ wave: waveObj, candles });

    if (!chartImage) {
      return res.status(500).json({ error: 'Chart generation failed — check python3/pillow' });
    }

    // Mandar notificación Telegram
    await telegram.notifyTradeOpened(
      {
        id:         wave.id,
        symbol:     wave.symbol,
        side:       wave.direction === 'bullish' ? 'long' : 'short',
        mode:       config.tradingMode,
        entryPrice: Number(wave.entryPrice),
        stopLoss:   Number(wave.stopLoss),
        target1:    Number(wave.target1),
        target2:    Number(wave.target2),
        usdAmount:  100, // valor ficticio para el test
        quantity:   0.001,
      },
      chartImage,
    );

    res.json({
      ok:      true,
      waveId:  wave.id,
      symbol:  wave.symbol,
      chartKb: (chartImage.length / 1024).toFixed(1),
    });

  } catch (err) {
    logger.error('GET /test/wave-chart error', err);
    res.status(500).json({ error: String(err) });
  }
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
      (config as unknown as Record<string, number>)[key] = num;
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
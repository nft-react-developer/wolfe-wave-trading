import { eq, and, gte, sql } from 'drizzle-orm';
import type { WolfeWave, Trade, TradeMode } from '../types';
import { getDb, schema } from '../db/connection';
import type { NewTradeRow } from '../db/schema';
import type { IExchange } from '../types';
import { config } from '../utils/config';
import { logger } from '../utils/logger';

const { trades, wolfeWaves } = schema;

// ─── Risk Guard ───────────────────────────────────────────────────────────────

export class RiskGuard {
  private paused = false;
  private pausedOnDate = ''; // UTC date string when pause was triggered e.g. '2026-03-13'

  constructor(private mode: TradeMode) {}

  isPaused(): boolean { return this.paused; }

  pause(): void {
    this.paused = true;
    logger.info('RiskGuard: bot manually paused');
  }

  resume(): void {
    this.paused = false;
    logger.info('RiskGuard: bot resumed');
  }

  /**
   * Check whether opening a new trade is allowed.
   * Returns { allowed: true } or { allowed: false, reason: string }.
   */
  async canOpenTrade(symbol: string): Promise<{ allowed: boolean; reason?: string }> {
    if (this.paused) {
      return { allowed: false, reason: 'Bot is paused due to daily loss limit' };
    }

    const db = await getDb();

    // ── Total open trades limit ──────────────────────────────────────────────
    if (config.maxOpenTradesTotal > 0) {
      const [{ count }] = await db
        .select({ count: sql<number>`count(*)` })
        .from(trades)
        .where(and(eq(trades.status, 'open'), eq(trades.mode, this.mode)));

      if (Number(count) >= config.maxOpenTradesTotal) {
        return {
          allowed: false,
          reason: `Max open trades reached (${config.maxOpenTradesTotal})`,
        };
      }
    }

    // ── Per-symbol open trades limit ─────────────────────────────────────────
    if (config.maxOpenTradesPerSymbol > 0) {
      const [{ count }] = await db
        .select({ count: sql<number>`count(*)` })
        .from(trades)
        .where(and(
          eq(trades.status, 'open'),
          eq(trades.mode, this.mode),
          eq(trades.symbol, symbol),
        ));

      if (Number(count) >= config.maxOpenTradesPerSymbol) {
        return {
          allowed: false,
          reason: `Max open trades for ${symbol} reached (${config.maxOpenTradesPerSymbol})`,
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Calculate today's realized PnL and pause the bot if it exceeds
   * the configured daily loss threshold.
   * Call once per scan cycle.
   */
  async checkDailyDrawdown(): Promise<void> {
    if (config.maxDailyLossPct <= 0) return;

    const db = await getDb();

    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);

    const closedToday = await db
      .select({ pnl: trades.pnl })
      .from(trades)
      .where(and(
        eq(trades.status, 'closed'),
        eq(trades.mode, this.mode),
        gte(trades.exitTime, startOfDay.getTime()),
      ));

    const dailyPnl = closedToday.reduce((sum, t) => sum + Number(t.pnl ?? 0), 0);

    // dailyPnl is negative when losing
    const lossThreshold = -Math.abs(config.initialCapital * config.maxDailyLossPct);

    const todayUtc = startOfDay.toISOString().slice(0, 10);

    // Auto-resume if a new UTC day has started since the pause was triggered
    if (this.paused && this.pausedOnDate && this.pausedOnDate !== todayUtc) {
      this.paused = false;
      this.pausedOnDate = '';
      logger.info('RiskGuard: new UTC day — bot automatically resumed');
    }

    if (dailyPnl <= lossThreshold && !this.paused) {
      this.paused = true;
      this.pausedOnDate = todayUtc;
      logger.warn('RiskGuard: daily loss limit hit — bot paused', {
        dailyPnl: dailyPnl.toFixed(2),
        threshold: lossThreshold.toFixed(2),
        pct: (config.maxDailyLossPct * 100).toFixed(1) + '%',
      });
    }
  }
}


// ─── Position sizing ──────────────────────────────────────────────────────────

export function calcPositionSize(
  entryPrice: number,
  stopLoss: number,
  availableCapital: number,
): { usdAmount: number; quantity: number } {
  const riskPct    = 0.01; // risk 1% of capital per trade
  const riskAmount = Math.min(availableCapital * riskPct, config.maxTradeAmount);

  const priceDiff = Math.abs(entryPrice - stopLoss);
  if (priceDiff === 0) return { usdAmount: 0, quantity: 0 };

  const quantity  = riskAmount / priceDiff;
  const usdAmount = quantity * entryPrice;

  // Hard cap
  const cappedUsd = Math.min(usdAmount, config.maxTradeAmount);
  const cappedQty = cappedUsd / entryPrice;

  // Mínimo de orden aceptado por CoinEx (30 USDT)
  const MIN_ORDER_USDT = 30;
  if (cappedUsd < MIN_ORDER_USDT) {
    if (availableCapital < MIN_ORDER_USDT) return { usdAmount: 0, quantity: 0 };
    const minQty = MIN_ORDER_USDT / entryPrice;
    return { usdAmount: MIN_ORDER_USDT, quantity: minQty };
  }

  return { usdAmount: cappedUsd, quantity: cappedQty };
}

// ─── Trade service ────────────────────────────────────────────────────────────

export class TradeService {
  constructor(
    private exchange: IExchange,
    private mode: TradeMode,
  ) {}

  // ─── Open a trade from a Wolfe Wave ────────────────────────────────────────

  async openTrade(
    wave: WolfeWave,
    waveId: number,
    availableCapital: number,
  ): Promise<Trade | null> {
    const db = await getDb();

    const { usdAmount, quantity } = calcPositionSize(
      wave.entryPrice,
      wave.stopLoss,
      availableCapital,
    );

    if (quantity <= 0 || usdAmount < 1) {
      logger.warn('Skipping trade: position size too small', { symbol: wave.symbol, usdAmount });
      return null;
    }

    if (usdAmount > availableCapital) {
      logger.warn('Skipping trade: insufficient balance', {
        symbol: wave.symbol,
        required: usdAmount.toFixed(2),
        available: availableCapital.toFixed(2),
      });
      return null;
    }

    // side / orderSide — typed as literals so Drizzle is happy
    const side:      'long' | 'short' = wave.direction === 'bullish' ? 'long' : 'short';
    const orderSide: 'buy'  | 'sell'  = side === 'long' ? 'buy' : 'sell';

    let entryOrderId: string | undefined;
    let slOrderId:    string | undefined;
    let filledQuantity: number = quantity; // default to intended quantity, will adjust after fill if needed

    try {

    logger.info('Placing entry order', {
        symbol:    wave?.symbol,
        side:      orderSide,
        type:      'market',
        quantity:  quantity?.toFixed(8),
        usdAmount: usdAmount?.toFixed(2),
        price:     wave?.entryPrice,
        sl:        wave?.stopLoss,
      });

    const entryOrder = await this.exchange.placeOrder({
      symbol:   wave.symbol,
      side:     orderSide,
      type:     'market',
      quantity,
      price:    wave.entryPrice,
    });
    entryOrderId = entryOrder.orderId;

    // Usar la cantidad real ejecutada para el SL
    // evita error "balance not enough" por diferencia de fees/slippage
    filledQuantity = entryOrder.quantity > 0 ? entryOrder.quantity : quantity;

    if (this.mode === 'real') {
      const slOrder = await this.exchange.placeOrder({
        symbol:   wave.symbol,
        side:     orderSide === 'buy' ? 'sell' : 'buy',
        type:     'limit',
        quantity: filledQuantity,   // ← cantidad real del fill
        price:    wave.stopLoss,
      });
        slOrderId = slOrder.orderId;
      }
    } catch (err) {
      logger.error('Failed to place entry order', err);
      return null;
    }

    const now = Date.now();

    // Build the insert record using NewTradeRow so every enum field is
    // typed as the literal union that Drizzle expects (not just `string`).
    const tradeRecord: NewTradeRow = {
      wolfeWaveId:  waveId,
      symbol:       wave.symbol,
      timeframe:    wave.timeframe,
      side,                          // 'long' | 'short'  ✓
      mode:         this.mode,       // 'paper' | 'real'  ✓
      status:       'open',          // enum literal       ✓
      entryPrice:   wave.entryPrice.toFixed(8),
      entryTime:    now,
      quantity:     filledQuantity.toFixed(8), 
      usdAmount:    usdAmount.toFixed(2),
      stopLoss:     wave.stopLoss.toFixed(8),
      target1:      wave.target1.toFixed(8),
      target2:      wave.target2.toFixed(8),
      target3:      wave.target3?.toFixed(8),
      target4:      wave.target4?.toFixed(8),
      closedQty1:   '0',
      closedQty2:   '0',
      closedQty3:   '0',
      closedQty4:   '0',
      entryOrderId,
      slOrderId,
    };

    const [result] = await db.insert(trades).values(tradeRecord);

    logger.info('Trade opened', {
      id:     result.insertId,
      symbol: wave.symbol,
      side,
      mode:   this.mode,
      entry:  wave.entryPrice,
      sl:     wave.stopLoss,
      tp1:    wave.target1,
      tp2:    wave.target2,
    });

    return {
      id:           result.insertId,
      wolfeWaveId:  waveId,
      symbol:       wave.symbol,
      timeframe:    wave.timeframe,
      side,
      mode:         this.mode,
      status:       'open',
      entryPrice:   wave.entryPrice,
      entryTime:    now,
      quantity,
      usdAmount,
      stopLoss:     wave.stopLoss,
      target1:      wave.target1,
      target2:      wave.target2,
      target3:      wave.target3,
      target4:      wave.target4,
      closedQty1:   0,
      closedQty2:   0,
      closedQty3:   0,
      closedQty4:   0,
      entryOrderId,
      slOrderId,
    };
  }

  // ─── Reconcile open trades against the exchange on startup (real mode only) ──
  //
  // On restart we don't know if any SL/TP orders were filled while the bot
  // was down. This method queries the exchange for every order ID stored in
  // the DB and updates trade state accordingly before the scan loop begins.

  async reconcileOpenTrades(): Promise<void> {
    if (this.mode !== 'real') return;

    const db = await getDb();
    const openTrades = await db
      .select()
      .from(trades)
      .where(and(eq(trades.status, 'open'), eq(trades.mode, 'real')));

    if (openTrades.length === 0) {
      logger.info('Reconciliation: no open real trades found');
      return;
    }

    logger.info(`Reconciliation: checking ${openTrades.length} open trade(s) against exchange`);

    for (const trade of openTrades) {
      try {
        await this.reconcileTrade(trade);
      } catch (err) {
        logger.error(`Reconciliation failed for trade #${trade.id}`, err);
      }
    }

    logger.info('Reconciliation complete');
  }

  private async reconcileTrade(trade: typeof trades.$inferSelect): Promise<void> {
    const db     = await getDb();
    const isLong = trade.side === 'long';
    const qty    = Number(trade.quantity);
    const entry  = Number(trade.entryPrice);

    // ── Check SL order ────────────────────────────────────────────────────────
    if (trade.slOrderId) {
      const slOrder = await this.exchange.getOrder(trade.symbol, trade.slOrderId);

      if (slOrder.status === 'filled') {
        const fillPrice = slOrder.filledPrice ?? Number(trade.stopLoss);
        const remaining = qty
          - Number(trade.closedQty1)
          - Number(trade.closedQty2)
          - Number(trade.closedQty3)
          - Number(trade.closedQty4);
        const pnl = this.calcPnl(entry, fillPrice, remaining, isLong);

        await this.closeTrade(trade.id!, fillPrice, 'sl', pnl);
        await db.update(wolfeWaves)
          .set({ hitStopLoss: true })
          .where(eq(wolfeWaves.id, trade.wolfeWaveId));

        logger.info(`Reconciliation: trade #${trade.id} SL was filled at ${fillPrice} — closed`);
        return; // no need to check TPs
      }

      if (slOrder.status === 'cancelled') {
        // SL was cancelled externally — log and cancel our DB record too
        logger.warn(`Reconciliation: trade #${trade.id} SL order was cancelled externally`);
        await db.update(trades)
          .set({ slOrderId: null })
          .where(eq(trades.id, trade.id!));
      }
    }

    // ── Check TP1 order ───────────────────────────────────────────────────────
    if (trade.tp1OrderId && Number(trade.closedQty1) === 0) {
      const tp1Order = await this.exchange.getOrder(trade.symbol, trade.tp1OrderId);

      if (tp1Order.status === 'filled') {
        const fillPrice  = tp1Order.filledPrice ?? Number(trade.target1);
        const partialQty = qty * 0.5;

        await db.update(trades).set({
          closedQty1: partialQty.toFixed(8),
          stopLoss:   entry.toFixed(8),         // move SL to breakeven
        }).where(eq(trades.id, trade.id!));

        await db.update(wolfeWaves)
          .set({ reachedTarget1: true })
          .where(eq(wolfeWaves.id, trade.wolfeWaveId));

        logger.info(`Reconciliation: trade #${trade.id} TP1 was filled at ${fillPrice}`);
      }
    }

    // ── Check TP2 order ───────────────────────────────────────────────────────
    if (trade.tp2OrderId && Number(trade.closedQty2) === 0) {
      const tp2Order = await this.exchange.getOrder(trade.symbol, trade.tp2OrderId);

      if (tp2Order.status === 'filled') {
        const fillPrice = tp2Order.filledPrice ?? Number(trade.target2);
        const hasTP3    = trade.target3 != null;

        if (hasTP3) {
          // Fat M/W: partial close at TP2
          const partialQty = (qty - Number(trade.closedQty1)) * 0.5;
          await db.update(trades)
            .set({ closedQty2: partialQty.toFixed(8) })
            .where(eq(trades.id, trade.id!));
          await db.update(wolfeWaves)
            .set({ reachedTarget2: true })
            .where(eq(wolfeWaves.id, trade.wolfeWaveId));
          logger.info(`Reconciliation: trade #${trade.id} TP2 (fat) filled at ${fillPrice}`);
        } else {
          // Standard wave: full close at TP2
          const remaining = qty - Number(trade.closedQty1);
          const pnl = this.calcPnl(entry, fillPrice, remaining, isLong);
          await this.closeTrade(trade.id!, fillPrice, 'tp2', pnl);
          await db.update(wolfeWaves)
            .set({ reachedTarget2: true })
            .where(eq(wolfeWaves.id, trade.wolfeWaveId));
          logger.info(`Reconciliation: trade #${trade.id} TP2 was filled at ${fillPrice} — closed`);
        }
      }
    }
  }

  // ─── Monitor open trades against latest price ───────────────────────────────
  //
  // candlesMap is optional — only needed when TRAILING_STOP_METHOD=structure or atr.
  // The scanner passes it during the polling cycle (candles already fetched).
  // In websocket mode it is omitted; trailing stop falls back to percentage mode.

  async checkOpenTrades(
    currentPrices: Record<string, number>,
    candlesMap?: Record<string, import('../types').Candle[]>,
  ): Promise<void> {
    const db = await getDb();

    const openTrades = await db
      .select()
      .from(trades)
      .where(and(eq(trades.status, 'open'), eq(trades.mode, this.mode)));

    for (const trade of openTrades) {
      const price = currentPrices[trade.symbol];
      if (price === undefined) continue;
      const candles = candlesMap?.[trade.symbol];
      await this.evaluateTrade(trade, price, candles);
    }
  }

  // ─── Evaluate a single trade ────────────────────────────────────────────────

  private async evaluateTrade(
    trade: typeof trades.$inferSelect,
    currentPrice: number,
    candles?: import('../types').Candle[],
  ): Promise<void> {
    const db = await getDb();

    const entry = Number(trade.entryPrice);
    const sl    = Number(trade.stopLoss);
    const tp1   = Number(trade.target1);
    const tp2   = Number(trade.target2);
    const tp3   = trade.target3 != null ? Number(trade.target3) : undefined;
    const tp4   = trade.target4 != null ? Number(trade.target4) : undefined;
    const qty   = Number(trade.quantity);

    const closedQty1 = Number(trade.closedQty1);
    const closedQty2 = Number(trade.closedQty2);
    const closedQty3 = Number(trade.closedQty3);
    const closedQty4 = Number(trade.closedQty4);

    const isLong = trade.side === 'long';

    // Al principio de evaluateTrade, en modo real verificar si el SL ya fue ejecutado en el exchange
    if (this.mode === 'real' && trade.slOrderId) {
      try {
        const slOrder = await this.exchange.getOrder(trade.symbol, trade.slOrderId);
        if (slOrder.status === 'filled') {
          const fillPrice = slOrder.filledPrice ?? Number(trade.stopLoss);
          const remaining = qty - closedQty1 - closedQty2 - closedQty3 - closedQty4;
          const pnl = this.calcPnl(entry, fillPrice, remaining, isLong);
          await this.closeTrade(trade.id!, fillPrice, 'sl', pnl);
          await db.update(wolfeWaves)
            .set({ hitStopLoss: true })
            .where(eq(wolfeWaves.id, trade.wolfeWaveId));
          logger.info('SL order filled on exchange — trade closed', {
            id: trade.id, symbol: trade.symbol, fillPrice,
          });
          return;
        }
      } catch (err) {
        logger.warn(`Could not check SL order status for trade #${trade.id}`, err);
      }
    }

    // ── Stop Loss ───────────────────────────────────────────────────────────
    const slHit = isLong ? currentPrice <= sl : currentPrice >= sl;
    if (slHit) {
      const remaining = qty - closedQty1 - closedQty2 - closedQty3 - closedQty4;
      const pnl = this.calcPnl(entry, currentPrice, remaining, isLong);
      await this.closeTrade(trade.id!, currentPrice, 'sl', pnl);
      await db.update(wolfeWaves)
        .set({ hitStopLoss: true })
        .where(eq(wolfeWaves.id, trade.wolfeWaveId));
      return;
    }

    // ── Target 1: close 50%, move SL to breakeven ───────────────────────────
    const tp1Hit = closedQty1 === 0 && (isLong ? currentPrice >= tp1 : currentPrice <= tp1);
    if (tp1Hit) {
      const partialQty = qty * 0.5;

      if (this.mode === 'real') {
        try {
          await this.exchange.placeOrder({
            symbol:   trade.symbol,
            side:     isLong ? 'sell' : 'buy',
            type:     'market',
            quantity: partialQty,
            price:    currentPrice,
          });
        } catch (err) {
          logger.error('TP1 partial close failed', err);
        }
      }

      await db.update(trades).set({
        closedQty1: partialQty.toFixed(8),
        stopLoss:   entry.toFixed(8), // move SL to breakeven
      }).where(eq(trades.id, trade.id!));

      await db.update(wolfeWaves)
        .set({ reachedTarget1: true })
        .where(eq(wolfeWaves.id, trade.wolfeWaveId));

      logger.info('TP1 hit — partial close 50%, SL moved to BE', {
        id: trade.id, symbol: trade.symbol, price: currentPrice,
      });
      return;
    }

    // ── Trailing Stop (active after TP1, i.e. closedQty1 > 0) ───────────────
    if (closedQty1 > 0 && config.trailingStopMethod !== undefined) {
      await this.applyTrailingStop(trade, currentPrice, sl, isLong, candles);
      // Re-read stopLoss from DB in case it was updated, to avoid stale sl below
      const [refreshed] = await db.select({ stopLoss: trades.stopLoss })
        .from(trades).where(eq(trades.id, trade.id!));
      if (refreshed) {
        const newSl = Number(refreshed.stopLoss);
        const slHitAfterTrail = isLong ? currentPrice <= newSl : currentPrice >= newSl;
        if (slHitAfterTrail) {
          const remaining = qty - closedQty1 - closedQty2 - closedQty3 - closedQty4;
          const pnl = this.calcPnl(entry, currentPrice, remaining, isLong);
          await this.closeTrade(trade.id!, currentPrice, 'sl', pnl);
          await db.update(wolfeWaves)
            .set({ hitStopLoss: true })
            .where(eq(wolfeWaves.id, trade.wolfeWaveId));
          return;
        }
      }
    }

    // ── Target 2 ────────────────────────────────────────────────────────────
    const tp2Hit = closedQty1 > 0 && closedQty2 === 0 &&
      (isLong ? currentPrice >= tp2 : currentPrice <= tp2);

    if (tp2Hit) {
      if (tp3 !== undefined) {
        // Fat M/W: close 50% of remaining, let the rest run to TP3
        const partialQty = (qty - closedQty1) * 0.5;
        if (this.mode === 'real') {
          try {
            await this.exchange.placeOrder({
              symbol:   trade.symbol,
              side:     isLong ? 'sell' : 'buy',
              type:     'market',
              quantity: partialQty,
              price:    currentPrice,
            });
          } catch (err) {
            logger.error('TP2 partial close failed', err);
          }
        }
        await db.update(trades)
          .set({ closedQty2: partialQty.toFixed(8) })
          .where(eq(trades.id, trade.id!));
        await db.update(wolfeWaves)
          .set({ reachedTarget2: true })
          .where(eq(wolfeWaves.id, trade.wolfeWaveId));
        logger.info('TP2 hit (fat M/W) — partial close', { id: trade.id, price: currentPrice });
      } else {
        // Standard wave: close everything at TP2
        const remaining = qty - closedQty1;
        const pnl = this.calcPnl(entry, currentPrice, remaining, isLong);
        await this.closeTrade(trade.id!, currentPrice, 'tp2', pnl);
        await db.update(wolfeWaves)
          .set({ reachedTarget2: true })
          .where(eq(wolfeWaves.id, trade.wolfeWaveId));
      }
      return;
    }

    // ── Target 3 (fat M/W only) ─────────────────────────────────────────────
    if (tp3 !== undefined) {
      const tp3Hit = closedQty2 > 0 && closedQty3 === 0 &&
        (isLong ? currentPrice >= tp3 : currentPrice <= tp3);

      if (tp3Hit) {
        if (tp4 !== undefined) {
          const partialQty = (qty - closedQty1 - closedQty2) * 0.5;
          if (this.mode === 'real') {
            try {
              await this.exchange.placeOrder({
                symbol:   trade.symbol,
                side:     isLong ? 'sell' : 'buy',
                type:     'market',
                quantity: partialQty,
                price:    currentPrice,
              });
            } catch (err) {
              logger.error('TP3 partial close failed', err);
            }
          }
          await db.update(trades)
            .set({ closedQty3: partialQty.toFixed(8) })
            .where(eq(trades.id, trade.id!));
          await db.update(wolfeWaves)
            .set({ reachedTarget3: true })
            .where(eq(wolfeWaves.id, trade.wolfeWaveId));
          logger.info('TP3 hit — partial close', { id: trade.id, price: currentPrice });
        } else {
          const remaining = qty - closedQty1 - closedQty2;
          const pnl = this.calcPnl(entry, currentPrice, remaining, isLong);
          await this.closeTrade(trade.id!, currentPrice, 'tp3', pnl);
          await db.update(wolfeWaves)
            .set({ reachedTarget3: true })
            .where(eq(wolfeWaves.id, trade.wolfeWaveId));
        }
        return;
      }
    }

    // ── Target 4 (161.8% extension) ─────────────────────────────────────────
    if (tp4 !== undefined) {
      const tp4Hit = closedQty3 > 0 && closedQty4 === 0 &&
        (isLong ? currentPrice >= tp4 : currentPrice <= tp4);

      if (tp4Hit) {
        const remaining = qty - closedQty1 - closedQty2 - closedQty3;
        const pnl = this.calcPnl(entry, currentPrice, remaining, isLong);
        await this.closeTrade(trade.id!, currentPrice, 'tp4', pnl);
        logger.info('TP4 (161.8%) hit!', { id: trade.id, price: currentPrice });
      }
    }
  }

  // ─── Trailing Stop ────────────────────────────────────────────────────────
  //
  // Called once per price tick (WS mode) or per scan cycle (polling mode)
  // after TP1 has been hit. Calculates the new trailing SL and updates the
  // DB + exchange order if the improvement exceeds the minimum move threshold.

  private async applyTrailingStop(
    trade:        typeof trades.$inferSelect,
    currentPrice: number,
    currentSl:    number,
    isLong:       boolean,
    candles?:     import('../types').Candle[],
  ): Promise<void> {
    const newSl = this.calcTrailingStop(currentPrice, currentSl, isLong, candles);
    if (newSl === null) return;

    // Only move SL in the favorable direction
    const improved = isLong ? newSl > currentSl : newSl < currentSl;
    if (!improved) return;

    // Check minimum move threshold before touching the exchange
    const minMove = config.trailingStopMinMove;
    const movePct = Math.abs(newSl - currentSl) / currentSl;
    if (movePct < minMove) return;

    const db = await getDb();

    // Update DB
    await db.update(trades)
      .set({ stopLoss: newSl.toFixed(8) })
      .where(eq(trades.id, trade.id!));

    logger.debug('Trailing stop updated', {
      id:       trade.id,
      symbol:   trade.symbol,
      oldSl:    currentSl.toFixed(8),
      newSl:    newSl.toFixed(8),
      method:   config.trailingStopMethod,
    });

    // Update exchange order in real mode: cancel old SL, place new one
    if (this.mode === 'real' && trade.slOrderId) {
      try {
        await this.exchange.cancelOrder(trade.symbol, trade.slOrderId);

        const remaining =
          Number(trade.quantity)
          - Number(trade.closedQty1)
          - Number(trade.closedQty2)
          - Number(trade.closedQty3)
          - Number(trade.closedQty4);

        const newSlOrder = await this.exchange.placeOrder({
          symbol:   trade.symbol,
          side:     isLong ? 'sell' : 'buy',
          type:     'limit',
          quantity: remaining,
          price:    newSl,
        });

        await db.update(trades)
          .set({ slOrderId: newSlOrder.orderId })
          .where(eq(trades.id, trade.id!));

        logger.info('Trailing stop order replaced on exchange', {
          id: trade.id, newSl: newSl.toFixed(8), orderId: newSlOrder.orderId,
        });
      } catch (err) {
        logger.error('Failed to replace trailing SL order on exchange', err);
      }
    }
  }

  /**
   * Calculate the new trailing stop level based on the configured method.
   * Returns null if no valid level can be computed (e.g. not enough candles).
   *
   * - structure:  SL = lowest/highest CLOSE of the last N candles
   * - percentage: SL = currentPrice ± (currentPrice * trailingStopPct)
   * - atr:        SL = currentPrice ± (ATR(N) * 1.5)
   */
  private calcTrailingStop(
    currentPrice: number,
    currentSl:    number,
    isLong:       boolean,
    candles?:     import('../types').Candle[],
  ): number | null {
    const method   = config.trailingStopMethod;
    const lookback = config.trailingStopLookback;

    if (method === 'percentage') {
      const offset = currentPrice * config.trailingStopPct;
      return isLong ? currentPrice - offset : currentPrice + offset;
    }

    // Structure and ATR both require recent candles
    if (!candles || candles.length < lookback) {
      // Fall back to percentage if no candles available (e.g. WS mode)
      const offset = currentPrice * config.trailingStopPct;
      return isLong ? currentPrice - offset : currentPrice + offset;
    }

    const recent = candles.slice(-lookback);

    if (method === 'structure') {
      // Use close prices (Alba Puerro methodology)
      const closes = recent.map(c => c.close);
      return isLong
        ? Math.min(...closes)   // lowest recent close — SL trails below price
        : Math.max(...closes);  // highest recent close — SL trails above price
    }

    if (method === 'atr') {
      // ATR = average of |high-low| over last N candles (simplified true range)
      const trValues = recent.map(c => c.high - c.low);
      const atr = trValues.reduce((sum, v) => sum + v, 0) / trValues.length;
      const multiplier = 1.5;
      return isLong
        ? currentPrice - atr * multiplier
        : currentPrice + atr * multiplier;
    }

    return null;
  }

  // ─── PnL helpers ────────────────────────────────────────────────────────────

  private calcPnl(
    entryPrice: number,
    exitPrice:  number,
    quantity:   number,
    isLong:     boolean,
  ): number {
    return isLong
      ? (exitPrice - entryPrice) * quantity
      : (entryPrice - exitPrice) * quantity;
  }

  // ─── Close a trade ──────────────────────────────────────────────────────────

  private async closeTrade(
    tradeId:   number,
    exitPrice: number,
    reason:    'tp1' | 'tp2' | 'tp3' | 'tp4' | 'sl' | 'manual' | 'timeout',
    pnl:       number,
  ): Promise<void> {
    const db = await getDb();

    const [trade] = await db.select().from(trades).where(eq(trades.id, tradeId));
    if (!trade) return;

    const usdAmount = Number(trade.usdAmount);
    const pnlPct    = usdAmount > 0 ? (pnl / usdAmount) * 100 : 0;

    await db.update(trades).set({
      status:     'closed',
      exitPrice:  exitPrice.toFixed(8),
      exitTime:   Date.now(),
      closeReason: reason,
      pnl:        pnl.toFixed(2),
      pnlPct:     pnlPct.toFixed(4),
    }).where(eq(trades.id, tradeId));

    logger.info('Trade closed', {
      id: tradeId, reason, exitPrice,
      pnl: pnl.toFixed(2), pnlPct: pnlPct.toFixed(2),
    });
  }
}
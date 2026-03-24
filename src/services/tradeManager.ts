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
  private pausedOnDate = '';

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
  const riskPct    = 0.01;
  const riskAmount = Math.min(availableCapital * riskPct, config.maxTradeAmount);

  const priceDiff = Math.abs(entryPrice - stopLoss);
  if (priceDiff === 0) return { usdAmount: 0, quantity: 0 };

  const quantity  = riskAmount / priceDiff;
  const usdAmount = quantity * entryPrice;

  const cappedUsd = Math.min(usdAmount, config.maxTradeAmount);
  const cappedQty = cappedUsd / entryPrice;

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
    let filledQuantity = quantity;
    let adjustedSL     = wave.stopLoss;

    try {
      logger.info('Placing entry order', {
        symbol:    wave.symbol,
        side:      orderSide,
        type:      'market',
        quantity:  quantity.toFixed(8),
        usdAmount: usdAmount.toFixed(2),
        price:     wave.entryPrice,
        sl:        wave.stopLoss,
      });

      const entryOrder = await this.exchange.placeOrder({
        symbol:   wave.symbol,
        side:     orderSide,
        type:     'market',
        quantity,
        price:    wave.entryPrice,
      });
      entryOrderId = entryOrder.orderId;

      // Usar cantidad real ejecutada para el SL
      filledQuantity = entryOrder.quantity > 0 ? entryOrder.quantity : quantity;

      // Recalcular SL basado en el precio real del fill
      const filledPrice = entryOrder.filledPrice ?? wave.entryPrice;
      const slDistance  = Math.abs(wave.entryPrice - wave.stopLoss);
      adjustedSL = wave.direction === 'bullish'
        ? filledPrice - slDistance
        : filledPrice + slDistance;

      logger.info('SL ajustado al precio real del fill', {
        symbol:      wave.symbol,
        p5Price:     wave.entryPrice,
        filledPrice,
        slOriginal:  wave.stopLoss,
        slAjustado:  adjustedSL,
        distancia:   slDistance.toFixed(8),
      });

      // ── Colocar Stop Order nativa en el exchange (modo real) ──────────────
      // Usamos type='market' para garantizar ejecución al ser activada.
      // trigger_price = adjustedSL → solo se activa cuando el precio
      // baja (long) o sube (short) hasta ese nivel.
      if (this.mode === 'real') {
        const slStopOrder = await this.exchange.placeStopOrder({
          symbol:       wave.symbol,
          side:         orderSide === 'buy' ? 'sell' : 'buy',  // sentido contrario
          type:         'market',
          quantity:     filledQuantity,
          triggerPrice: adjustedSL,
        });
        slOrderId = slStopOrder.stopId;

        logger.info('Stop order SL colocada en exchange', {
          symbol:       wave.symbol,
          stopId:       slOrderId,
          triggerPrice: adjustedSL.toFixed(8),
          side:         slStopOrder.side,
        });
      }
    } catch (err) {
      logger.error('Failed to place entry or SL order', err);
      return null;
    }

    const now = Date.now();

    // Build the insert record using NewTradeRow so every enum field is
    // typed as the literal union that Drizzle expects (not just `string`).
    const tradeRecord: NewTradeRow = {
      wolfeWaveId:  waveId,
      symbol:       wave.symbol,
      timeframe:    wave.timeframe,
      side,
      mode:         this.mode,
      status:       'open',
      entryPrice:   wave.entryPrice.toFixed(8),
      entryTime:    now,
      quantity:     filledQuantity.toFixed(8),
      usdAmount:    usdAmount.toFixed(2),
      stopLoss:     adjustedSL.toFixed(8),
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
      sl:     adjustedSL,
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
      stopLoss:     adjustedSL,
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

  // ─── Reconcile open trades (real mode only) ────────────────────────────────

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

    // ── Verificar stop order (SL nativo) ─────────────────────────────────────
    if (trade.slOrderId) {
      try {
        const slStop = await this.exchange.getStopOrder(trade.symbol, trade.slOrderId);

        if (slStop.status === 'triggered') {
          // La stop order se activó mientras el bot estaba offline.
          // Asumimos ejecución al precio de trigger como aproximación.
          const fillPrice = slStop.triggerPrice > 0 ? slStop.triggerPrice : Number(trade.stopLoss);
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

          logger.info(`Reconciliation: trade #${trade.id} stop triggered at ~${fillPrice} — closed`);
          return;
        }

        if (slStop.status === 'cancelled') {
          logger.warn(`Reconciliation: trade #${trade.id} stop order was cancelled externally`);
          await db.update(trades)
            .set({ slOrderId: null })
            .where(eq(trades.id, trade.id!));
        }
      } catch (err) {
        logger.warn(`Reconciliation: could not check stop order for trade #${trade.id}`, err);
      }
    }

    // ── Verificar TP1 ─────────────────────────────────────────────────────────
    if (trade.tp1OrderId && Number(trade.closedQty1) === 0) {
      const tp1Order = await this.exchange.getOrder(trade.symbol, trade.tp1OrderId);

      if (tp1Order.status === 'filled') {
        const fillPrice  = tp1Order.filledPrice ?? Number(trade.target1);
        const partialQty = qty * 0.5;

        await db.update(trades).set({
          closedQty1: partialQty.toFixed(8),
          stopLoss:   entry.toFixed(8),
        }).where(eq(trades.id, trade.id!));

        await db.update(wolfeWaves)
          .set({ reachedTarget1: true })
          .where(eq(wolfeWaves.id, trade.wolfeWaveId));

        logger.info(`Reconciliation: trade #${trade.id} TP1 was filled at ${fillPrice}`);
      }
    }

    // ── Verificar TP2 ─────────────────────────────────────────────────────────
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

  // ─── Monitor open trades ───────────────────────────────────────────────────

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
    trade:        typeof trades.$inferSelect,
    currentPrice: number,
    candles?:     import('../types').Candle[],
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

    // ── Stop Loss (monitoreo por software) ────────────────────────────────────
    // El SL se monitorea aquí comparando el precio actual con trade.stopLoss.
    // La stop order nativa del exchange actúa como red de seguridad si el bot
    // se cae o pierde conectividad — se reconcilia en reconcileOpenTrades()
    // al arrancar.
    //
    // IMPORTANTE: NO consultamos getStopOrder() en cada tick porque la API de
    // CoinEx puede tardar unos segundos en reflejar una orden recién creada en
    // el endpoint de pendientes, lo que causaría falsos positivos (la orden no
    // aparece en la lista → se interpreta como triggered → cierre incorrecto).
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

    // ── Target 1: cerrar 50%, mover SL a breakeven ──────────────────────────
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

      // Mover SL a breakeven: cancelar la stop order actual y colocar nueva
      const remaining = qty - partialQty;
      const newSlPrice = entry; // breakeven

      if (this.mode === 'real' && trade.slOrderId) {
        await this.replaceStopOrder(trade, remaining, newSlPrice, isLong);
      }

      await db.update(trades).set({
        closedQty1: partialQty.toFixed(8),
        stopLoss:   newSlPrice.toFixed(8),
      }).where(eq(trades.id, trade.id!));

      await db.update(wolfeWaves)
        .set({ reachedTarget1: true })
        .where(eq(wolfeWaves.id, trade.wolfeWaveId));

      logger.info('TP1 hit — partial close 50%, SL moved to BE', {
        id: trade.id, symbol: trade.symbol, price: currentPrice, newSL: newSlPrice,
      });
      return;
    }

    // ── Trailing Stop (activo después de TP1) ────────────────────────────────
    if (closedQty1 > 0 && config.trailingStopMethod !== undefined) {
      await this.applyTrailingStop(trade, currentPrice, sl, isLong, candles);
      // Re-leer SL actualizado
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
        const remaining = qty - closedQty1;
        const pnl = this.calcPnl(entry, currentPrice, remaining, isLong);
        // Cancelar stop order ya que vamos a cerrar la posición
        if (this.mode === 'real' && trade.slOrderId) {
          try { await this.exchange.cancelStopOrder(trade.symbol, trade.slOrderId); }
          catch (err) { logger.warn('Could not cancel stop order at TP2 close', err); }
        }
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
          if (this.mode === 'real' && trade.slOrderId) {
            try { await this.exchange.cancelStopOrder(trade.symbol, trade.slOrderId); }
            catch (err) { logger.warn('Could not cancel stop order at TP3 close', err); }
          }
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
        if (this.mode === 'real' && trade.slOrderId) {
          try { await this.exchange.cancelStopOrder(trade.symbol, trade.slOrderId); }
          catch (err) { logger.warn('Could not cancel stop order at TP4 close', err); }
        }
        await this.closeTrade(trade.id!, currentPrice, 'tp4', pnl);
        logger.info('TP4 (161.8%) hit!', { id: trade.id, price: currentPrice });
      }
    }
  }

  // ─── Reemplazar stop order en el exchange ─────────────────────────────────
  //
  // Se usa al mover SL a breakeven (después de TP1) y al actualizar trailing stop.
  // Cancela la stop order existente y coloca una nueva con el nuevo precio.

  private async replaceStopOrder(
    trade:       typeof trades.$inferSelect,
    quantity:    number,
    newSlPrice:  number,
    isLong:      boolean,
  ): Promise<string | undefined> {
    const db = await getDb();

    // Cancelar stop order actual
    if (trade.slOrderId) {
      try {
        await this.exchange.cancelStopOrder(trade.symbol, trade.slOrderId);
        logger.debug('Stop order cancelada para reemplazo', {
          id: trade.id, oldStopId: trade.slOrderId,
        });
      } catch (err) {
        logger.warn(`No se pudo cancelar stop order ${trade.slOrderId}`, err);
      }
    }

    // Colocar nueva stop order
    try {
      const newStop = await this.exchange.placeStopOrder({
        symbol:       trade.symbol,
        side:         isLong ? 'sell' : 'buy',
        type:         'market',
        quantity,
        triggerPrice: newSlPrice,
      });

      await db.update(trades)
        .set({ slOrderId: newStop.stopId })
        .where(eq(trades.id, trade.id!));

      logger.info('Stop order reemplazada en exchange', {
        id:          trade.id,
        newStopId:   newStop.stopId,
        triggerPrice: newSlPrice.toFixed(8),
      });

      return newStop.stopId;
    } catch (err) {
      logger.error('Failed to place replacement stop order', err);
      return undefined;
    }
  }

  // ─── Trailing Stop ────────────────────────────────────────────────────────

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

    // Actualizar DB primero
    await db.update(trades)
      .set({ stopLoss: newSl.toFixed(8) })
      .where(eq(trades.id, trade.id!));

    logger.debug('Trailing stop updated', {
      id:     trade.id,
      symbol: trade.symbol,
      oldSl:  currentSl.toFixed(8),
      newSl:  newSl.toFixed(8),
      method: config.trailingStopMethod,
    });

    // Reemplazar stop order en el exchange (real mode)
    if (this.mode === 'real') {
      const remaining =
        Number(trade.quantity)
        - Number(trade.closedQty1)
        - Number(trade.closedQty2)
        - Number(trade.closedQty3)
        - Number(trade.closedQty4);

      await this.replaceStopOrder(trade, remaining, newSl, isLong);
    }
  }

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

    if (!candles || candles.length < lookback) {
      const offset = currentPrice * config.trailingStopPct;
      return isLong ? currentPrice - offset : currentPrice + offset;
    }

    const recent = candles.slice(-lookback);

    if (method === 'structure') {
      const closes = recent.map(c => c.close);
      return isLong
        ? Math.min(...closes)
        : Math.max(...closes);
    }

    if (method === 'atr') {
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
      status:      'closed',
      exitPrice:   exitPrice.toFixed(8),
      exitTime:    Date.now(),
      closeReason: reason,
      pnl:         pnl.toFixed(2),
      pnlPct:      pnlPct.toFixed(4),
    }).where(eq(trades.id, tradeId));

    logger.info('Trade closed', {
      id: tradeId, reason, exitPrice,
      pnl: pnl.toFixed(2), pnlPct: pnlPct.toFixed(2),
    });
  }
}
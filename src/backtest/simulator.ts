import type { Candle, WolfeWave } from '../types';
import type { BacktestConfig, SimTrade, SimCloseReason } from './types';
import { postP5VolumeRatio, brokeEMA50 } from './filters';

// ─── Simulator ────────────────────────────────────────────────────────────────
// Simula el ciclo de vida de un trade desde la wave detectada hasta el cierre.
// Cada función "pura" recibe el estado mutable y la vela actual.
//
// Reglas pesimistas por default (configurables):
//  - Si SL y TP caen en la misma vela → asume SL primero
//  - Slippage en entradas market
//  - Fees por lado (entrada + cada parcial)
//  - Spread reducido en altcoin

// ─── Apertura del trade ───────────────────────────────────────────────────────

export function openTrade(
  wave:        WolfeWave,
  detectedIdx: number,
  candles:     Candle[],
  cfg:         BacktestConfig,
  equity:      number,
  tradeId:     number,
): SimTrade | null {
  // La entrada se ejecuta en la VELA SIGUIENTE a la detección (reflejo de
  // producción: el scanner detecta tras el cierre de la vela y opera al open
  // de la siguiente).
  const entryIdx = detectedIdx + 1;
  if (entryIdx >= candles.length) return null;

  // ── Resolver precio de entrada según modo ─────────────────────────────────
  const { entryPrice, actualEntryIdx } = resolveEntry(
    wave, entryIdx, candles, cfg,
  );
  if (entryPrice === null || actualEntryIdx === null) return null;

  // Ajustar SL al precio real de entrada (Alba: SL un poco más allá del P5;
  // si la entrada slippó, mantenemos la distancia original al P5)
  const slDist = Math.abs(wave.entryPrice - wave.stopLoss);
  const stopLoss = wave.direction === 'bullish'
    ? entryPrice - slDist
    : entryPrice + slDist;

  // ── Position sizing ────────────────────────────────────────────────────────
  const priceDiff = Math.abs(entryPrice - stopLoss);
  if (priceDiff <= 0) return null;

  const riskAmount = Math.min(equity * cfg.riskPerTradePct, cfg.maxTradeUsd);
  let qty = riskAmount / priceDiff;
  let usd = qty * entryPrice;

  if (usd > cfg.maxTradeUsd) {
    usd = cfg.maxTradeUsd;
    qty = usd / entryPrice;
  }
  if (usd < cfg.minOrderUsd) {
    if (equity < cfg.minOrderUsd) return null;
    usd = cfg.minOrderUsd;
    qty = usd / entryPrice;
  }

  // Cobrar fee + spread sobre el monto USD invertido
  const entryCost = usd * (cfg.feePctPerSide + cfg.spreadPct / 2);

  // ── Resolver TP1.5 (línea 1-4) si cae entre TP1 y TP2 ─────────────────────
  const tp15 = computeTp15(wave);

  const trade: SimTrade = {
    id:             tradeId,
    waveId:         (wave.id ?? -1),
    symbol:         wave.symbol,
    timeframe:      wave.timeframe,
    direction:      wave.direction,
    shape:          wave.shape,
    isPerfect:      wave.isPerfect,
    isDoubleWolfe:  wave.isDoubleWolfe,

    detectedAtIdx:  detectedIdx,
    entryIdx:       actualEntryIdx,
    entryPrice,
    entryTime:      candles[actualEntryIdx].timestamp,
    quantity:       qty,
    usdAmount:      usd,
    side:           wave.direction === 'bullish' ? 'long' : 'short',

    stopLoss,
    initialStopLoss: stopLoss,
    target1:        wave.target1,
    target15:       tp15,
    target2:        wave.target2,
    target3:        wave.target3,
    target4:        wave.target4,
    line14Price:    wave.line14Price,

    p5Index:        wave.p5.index,
    p5Price:        wave.p5.price,
    p5Volume:       candles[wave.p5.index]?.volume ?? 0,

    closedQty1:     0,
    closedQty2:     0,
    closedQty3:     0,
    closedQty4:     0,
    hitTp1:         false,
    hitTp15:        false,
    hitTp2:         false,
    hitTp3:         false,
    hitTp4:         false,

    // En netPnl se acumulan las pérdidas/ganancias parciales + fees
    grossPnl:       -entryCost,    // arranca con el costo de entrada (negativo)
    netPnl:         -entryCost,

    candlesInTrade: 0,
    mfe:            0,
    mae:            0,
    reentryNumber:  0,
  };

  return trade;
}

function resolveEntry(
  wave:    WolfeWave,
  startIdx: number,
  candles: Candle[],
  cfg:     BacktestConfig,
): { entryPrice: number | null; actualEntryIdx: number | null } {
  switch (cfg.entryMode) {
    case 'market_at_p5': {
      // Entrada al open de la siguiente vela con slippage
      const c = candles[startIdx];
      const slippage = cfg.slippagePct * (wave.direction === 'bullish' ? 1 : -1);
      return {
        entryPrice:     c.open * (1 + slippage),
        actualEntryIdx: startIdx,
      };
    }

    case 'confirm_candle': {
      // Esperar a que una vela cierre en favor del trade
      const maxLookahead = cfg.entryConfirmWindowCandles;
      for (let j = startIdx; j < Math.min(startIdx + maxLookahead, candles.length); j++) {
        const c = candles[j];
        const confirms = wave.direction === 'bullish'
          ? c.close > wave.entryPrice
          : c.close < wave.entryPrice;
        if (confirms) {
          // Entrar al close de esta vela (slippage simbólico)
          const slippage = cfg.slippagePct * (wave.direction === 'bullish' ? 1 : -1);
          return { entryPrice: c.close * (1 + slippage), actualEntryIdx: j };
        }
      }
      return { entryPrice: null, actualEntryIdx: null };
    }

    case 'limit_at_p5': {
      // Limit en P5 — válido N velas
      const maxLookahead = cfg.entryConfirmWindowCandles;
      for (let j = startIdx; j < Math.min(startIdx + maxLookahead, candles.length); j++) {
        const c = candles[j];
        const fills = wave.direction === 'bullish'
          ? c.low <= wave.entryPrice
          : c.high >= wave.entryPrice;
        if (fills) {
          // Sin slippage (limit), pero pagamos spread
          return { entryPrice: wave.entryPrice, actualEntryIdx: j };
        }
      }
      return { entryPrice: null, actualEntryIdx: null };
    }
  }
}

function computeTp15(wave: WolfeWave): number | undefined {
  if (wave.line14Price === undefined) return undefined;
  const inBetween = wave.direction === 'bullish'
    ? wave.line14Price > wave.target1 && wave.line14Price < wave.target2
    : wave.line14Price < wave.target1 && wave.line14Price > wave.target2;
  return inBetween ? wave.line14Price : undefined;
}

// ─── Evaluación por vela ──────────────────────────────────────────────────────

/**
 * Avanza un paso a todos los trades abiertos. Devuelve los que se cerraron
 * en esta vela.
 */
export function simulateOpenTrades(
  trades:    SimTrade[],
  visible:   Candle[],         // velas hasta el momento (incluida la actual)
  currentIdx: number,
  cfg:       BacktestConfig,
  fullCandles: Candle[],       // serie completa (para EMA50 que necesita closes)
): SimTrade[] {
  const closed: SimTrade[] = [];

  for (const trade of trades) {
    // No se evalúa el trade en su propia vela de entrada — esa fue solo apertura
    if (currentIdx <= trade.entryIdx) continue;

    const candle = visible[currentIdx];
    const isLong = trade.side === 'long';

    trade.candlesInTrade = currentIdx - trade.entryIdx;

    // ── Actualizar MFE / MAE ──────────────────────────────────────────────────
    const oneR = Math.abs(trade.entryPrice - trade.stopLoss);
    const favPx = isLong ? candle.high : candle.low;
    const advPx = isLong ? candle.low  : candle.high;
    const favR = (isLong ? favPx - trade.entryPrice : trade.entryPrice - favPx) / oneR;
    const advR = (isLong ? advPx - trade.entryPrice : trade.entryPrice - advPx) / oneR;
    trade.mfe = Math.max(trade.mfe ?? 0, favR);
    trade.mae = Math.min(trade.mae ?? 0, advR);

    // ── SL (mecha o cierre, según config) ─────────────────────────────────────
    const slHit = cfg.filters.useCloseBasedSL
      ? (isLong ? candle.close <= trade.stopLoss : candle.close >= trade.stopLoss)
      : (isLong ? candle.low   <= trade.stopLoss : candle.high  >= trade.stopLoss);

    // ── TPs ───────────────────────────────────────────────────────────────────
    const tp1Hit = !trade.hitTp1 && (
      isLong ? candle.high >= trade.target1 : candle.low <= trade.target1
    );
    const tp15Hit = !trade.hitTp15 && trade.target15 !== undefined && (
      isLong ? candle.high >= trade.target15 : candle.low <= trade.target15
    );
    const tp2Hit = !trade.hitTp2 && (
      isLong ? candle.high >= trade.target2 : candle.low <= trade.target2
    );
    const tp3Hit = !trade.hitTp3 && trade.target3 !== undefined && (
      isLong ? candle.high >= trade.target3 : candle.low <= trade.target3
    );
    const tp4Hit = !trade.hitTp4 && trade.target4 !== undefined && (
      isLong ? candle.high >= trade.target4 : candle.low <= trade.target4
    );

    // ── Filtros de salida temprana (§13 volumen, §11 EMA50) ───────────────────
    let volExit = false;
    if (cfg.filters.volumeExitRatio !== undefined && trade.p5Volume > 0) {
      // postP5VolumeRatio recibe sólo el índice del P5 — usamos un wave ligero
      const ratio = postP5VolumeRatio(
        { p5: { index: trade.p5Index, price: trade.p5Price, timestamp: 0 } } as WolfeWave,
        visible,
        currentIdx,
      );
      if (ratio >= cfg.filters.volumeExitRatio) volExit = true;
    }

    let emaTimeout = false;
    if (
      cfg.filters.ema50DeadlineCandles !== undefined &&
      trade.candlesInTrade >= cfg.filters.ema50DeadlineCandles &&
      !trade.brokeEMA50
    ) {
      const broke = brokeEMA50(
        fullCandles, trade.entryIdx, currentIdx,
        trade.direction, 50,
      );
      trade.brokeEMA50 = broke;
      if (!broke) emaTimeout = true;
    }

    // ── Decidir qué pasa este tick ────────────────────────────────────────────
    // Prioridad: SL > volume_exit > ema50_timeout > TPs en orden
    if (slHit) {
      closePartial(trade, currentIdx, candle, trade.stopLoss, 'sl', remainingQty(trade), cfg);
      closed.push(trade);
      continue;
    }

    if (volExit && !trade.hitTp1) {
      // Cierre completo a precio actual (sin parciales aún)
      closePartial(trade, currentIdx, candle, candle.close, 'volume_exit', remainingQty(trade), cfg);
      closed.push(trade);
      continue;
    }

    if (emaTimeout && !trade.hitTp1) {
      closePartial(trade, currentIdx, candle, candle.close, 'ema50_timeout', remainingQty(trade), cfg);
      closed.push(trade);
      continue;
    }

    // TPs — orden lógico: TP1 → TP1.5 → TP2 → TP3 → TP4
    // Si en la misma vela hay SL + TP, el flag ambiguousCandleSlFirst ya
    // priorizó SL arriba; si llegamos acá, no hubo SL.
    let stillOpen = true;

    if (tp1Hit && stillOpen) {
      const qtyToClose = trade.quantity * 0.5;
      closePartial(trade, currentIdx, candle, trade.target1, 'tp1', qtyToClose, cfg);
      trade.closedQty1 = qtyToClose;
      trade.hitTp1 = true;
      // Mover SL a breakeven tras TP1 (regla Alba §4)
      trade.stopLoss = trade.entryPrice;
    }

    if (tp15Hit && stillOpen && trade.target15 !== undefined) {
      const qtyToClose = trade.quantity * 0.25;
      closePartial(trade, currentIdx, candle, trade.target15, 'tp1.5', qtyToClose, cfg);
      trade.closedQty1 += qtyToClose;
      trade.hitTp15 = true;
    }

    if (tp2Hit && stillOpen) {
      const hasTP3 = trade.target3 !== undefined;
      const qtyToClose = hasTP3
        ? remainingQty(trade) * 0.5
        : remainingQty(trade);
      closePartial(trade, currentIdx, candle, trade.target2, 'tp2', qtyToClose, cfg);
      trade.closedQty2 = qtyToClose;
      trade.hitTp2 = true;
      if (!hasTP3) {
        closed.push(trade);
        stillOpen = false;
      }
    }

    if (tp3Hit && stillOpen && trade.target3 !== undefined) {
      const hasTP4 = trade.target4 !== undefined;
      const qtyToClose = hasTP4
        ? remainingQty(trade) * 0.5
        : remainingQty(trade);
      closePartial(trade, currentIdx, candle, trade.target3, 'tp3', qtyToClose, cfg);
      trade.closedQty3 = qtyToClose;
      trade.hitTp3 = true;
      if (!hasTP4) {
        closed.push(trade);
        stillOpen = false;
      }
    }

    if (tp4Hit && stillOpen && trade.target4 !== undefined) {
      const qtyToClose = remainingQty(trade);
      closePartial(trade, currentIdx, candle, trade.target4, 'tp4', qtyToClose, cfg);
      trade.closedQty4 = qtyToClose;
      trade.hitTp4 = true;
      closed.push(trade);
      stillOpen = false;
    }
  }

  return closed;
}

function remainingQty(trade: SimTrade): number {
  return trade.quantity
    - trade.closedQty1
    - trade.closedQty2
    - trade.closedQty3
    - trade.closedQty4;
}

function closePartial(
  trade:     SimTrade,
  idx:       number,
  candle:    Candle,
  price:     number,
  reason:    SimCloseReason,
  qty:       number,
  cfg:       BacktestConfig,
): void {
  if (qty <= 0) return;

  const isLong = trade.side === 'long';
  const grossPart = isLong
    ? (price - trade.entryPrice) * qty
    : (trade.entryPrice - price) * qty;

  const usdAtClose = qty * price;
  const exitCost = usdAtClose * (cfg.feePctPerSide + cfg.spreadPct / 2);

  trade.grossPnl = (trade.grossPnl ?? 0) + grossPart;
  trade.netPnl   = (trade.netPnl   ?? 0) + grossPart - exitCost;

  // Si es cierre total (queda 0 cantidad por cerrar), fijar exit
  const remaining = remainingQty(trade) - qty;
  if (remaining < 1e-12 || reason === 'sl' || reason === 'volume_exit' || reason === 'ema50_timeout') {
    trade.exitIdx     = idx;
    trade.exitPrice   = price;
    trade.exitTime    = candle.timestamp;
    trade.closeReason = reason;

    // 1R en USD = distancia entry→SL_inicial × cantidad total inicial
    const initialRiskUsd =
      Math.abs(trade.entryPrice - trade.initialStopLoss) * trade.quantity;
    trade.rMultiple = initialRiskUsd > 0 ? (trade.netPnl ?? 0) / initialRiskUsd : 0;
    trade.netPnlPct = trade.usdAmount > 0
      ? ((trade.netPnl ?? 0) / trade.usdAmount) * 100
      : 0;
  }
}

// ─── Cierre forzado al final del replay ───────────────────────────────────────

export function closeAllAtEnd(
  openTrades: SimTrade[],
  candles:    Candle[],
  cfg:        BacktestConfig,
): SimTrade[] {
  const last = candles[candles.length - 1];
  const lastIdx = candles.length - 1;
  const result: SimTrade[] = [];

  for (const trade of openTrades) {
    const rem = remainingQty(trade);
    if (rem > 0) {
      closePartial(trade, lastIdx, last, last.close, 'timeout', rem, cfg);
    }
    result.push(trade);
  }
  return result;
}

// ─── OHLCV Candle ─────────────────────────────────────────────────────────────

export interface Candle {
  timestamp: number; // unix ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ─── Wolfe Wave Points ────────────────────────────────────────────────────────

export type WolfeDirection = 'bullish' | 'bearish';

export interface WavePoint {
  index: number;   // candle index
  price: number;
  timestamp: number;
}

export interface WolfeWave {
  id?: number;
  symbol: string;
  timeframe: string;
  direction: WolfeDirection;
  p1: WavePoint;
  p2: WavePoint;
  p3: WavePoint;
  p4: WavePoint;
  p5: WavePoint;

  isPerfect: boolean;
  shape: 'perfect' | 'fat_mw' | 'long_neck' | 'imperfect';
  isDoubleWolfe: boolean;

  entryPrice: number;
  stopLoss: number;
  target1: number;
  target2: number;
  target3?: number;
  target4?: number;
  line14Price?: number;

  ema50: number;
  macdHistogram?: number;

  detectedAt: number;
}

// ─── Trade ────────────────────────────────────────────────────────────────────

export type TradeSide = 'long' | 'short';
export type TradeStatus = 'open' | 'closed' | 'cancelled';
export type TradeMode = 'paper' | 'real';
export type CloseReason = 'tp1' | 'tp2' | 'tp3' | 'tp4' | 'sl' | 'manual' | 'timeout';

export interface Trade {
  id?: number;
  wolfeWaveId: number;
  symbol: string;
  timeframe: string;
  side: TradeSide;
  mode: TradeMode;
  status: TradeStatus;

  entryPrice: number;
  entryTime: number;
  quantity: number;
  usdAmount: number;

  stopLoss: number;
  target1: number;
  target2: number;
  target3?: number;
  target4?: number;

  closedQty1: number;
  closedQty2: number;
  closedQty3: number;
  closedQty4: number;

  exitPrice?: number;
  exitTime?: number;
  closeReason?: CloseReason;
  pnl?: number;
  pnlPct?: number;

  entryOrderId?: string;
  slOrderId?: string;      // stop_id (string) de la stop order nativa
  tp1OrderId?: string;
  tp2OrderId?: string;

  notes?: string;
}

// ─── Statistics ───────────────────────────────────────────────────────────────

export interface WaveStats {
  total: number;
  perfect: number;
  imperfect: number;
  fat_mw: number;
  long_neck: number;
  successRate: number;
  perfectSuccessRate: number;
  imperfectSuccessRate: number;
  bySymbol: Record<string, { total: number; success: number }>;
  byTimeframe: Record<string, { total: number; success: number }>;
}

export interface TradeStats {
  mode: TradeMode;
  totalTrades: number;
  openTrades: number;
  closedTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalPnl: number;
  avgPnl: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  maxDrawdown: number;
  bySymbol: Record<string, { trades: number; pnl: number; winRate: number }>;
  byTimeframe: Record<string, { trades: number; pnl: number }>;
  byCloseReason: Record<string, number>;
}

export interface DailyReport {
  date: string;
  mode: TradeMode;
  tradesOpened: number;
  tradesClosed: number;
  dailyPnl: number;
  cumulativePnl: number;
  winRate: number;
  openPositions: number;
  balance: number;
  wavesDetected: number;
}

// ─── Exchange interfaces ──────────────────────────────────────────────────────

export interface ExchangeOrder {
  orderId: string;
  symbol: string;
  side: 'buy' | 'sell';
  price: number;
  quantity: number;
  status: 'open' | 'filled' | 'cancelled';
  filledPrice?: number;
  filledAt?: number;
}

/**
 * Stop order (trigger order) — queda pendiente hasta que el precio
 * de mercado alcanza trigger_price, momento en que se activa la orden
 * subyacente (market o limit).
 */
export interface ExchangeStopOrder {
  stopId: string;
  symbol: string;
  side: 'buy' | 'sell';
  type: 'market' | 'limit';
  quantity: number;
  triggerPrice: number;
  price?: number;          // solo para type='limit'
  status: 'open' | 'triggered' | 'cancelled';
}

// ─── Price Feed ──────────────────────────────────────────────────────────────

export interface IPriceFeed {
  start(symbols: string[], onPrice: (symbol: string, price: number) => void): void;
  stop(): void;
}

export interface IExchange {
  getName(): string;
  getCandles(symbol: string, timeframe: string, limit: number): Promise<Candle[]>;
  placeOrder(params: {
    symbol: string;
    side: 'buy' | 'sell';
    type: 'market' | 'limit';
    quantity: number;
    price?: number;
  }): Promise<ExchangeOrder>;
  cancelOrder(symbol: string, orderId: string): Promise<void>;
  getOrder(symbol: string, orderId: string): Promise<ExchangeOrder>;
  getBalance(): Promise<Record<string, number>>;

  // ── Stop orders (SL nativo del exchange) ──────────────────────────────────
  placeStopOrder(params: {
    symbol: string;
    side: 'buy' | 'sell';
    type: 'market' | 'limit';
    quantity: number;
    triggerPrice: number;
    price?: number;        // necesario cuando type='limit'
  }): Promise<ExchangeStopOrder>;
  cancelStopOrder(symbol: string, stopId: string): Promise<void>;
  getStopOrder(symbol: string, stopId: string): Promise<ExchangeStopOrder>;
}

// ─── Config ───────────────────────────────────────────────────────────────────

export interface AppConfig {
  tradingMode: TradeMode;
  initialCapital: number;
  maxTradeAmount: number;
  maxTradePct: number;
  scanTimeframes: string[];
  scanSymbols: string[];
  scanIntervalMs: number;
  macd: { fast: number; slow: number; signal: number };
  emaPeriod: number;
  apiPort: number;
  dailyReportCron: string;
  maxOpenTradesTotal: number;
  maxOpenTradesPerSymbol: number;
  maxDailyLossPct: number;
  priceFeed: 'polling' | 'websocket';
  trailingStopMethod:   'structure' | 'percentage' | 'atr';
  trailingStopLookback: number;
  trailingStopPct:      number;
  trailingStopMinMove:  number;
  symbolUpdateCron: string;
  updateSymbolsOnStartup: boolean;
  minRrRatio: number;
}
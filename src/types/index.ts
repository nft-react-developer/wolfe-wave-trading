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

/**
 * Wolfe Wave structure (5 points, Alba Puerro methodology)
 *
 * Bearish (shape "W") — short signal at point 5:
 *   P1 = prior low  | P2 = high (highest) | P3 = next low
 *   P4 = next high  | P5 = last low (< P3)
 *
 * Bullish (shape "M") — long signal at point 5:
 *   P2 = highest peak | P1 = low before P2 | P3 = low after P2
 *   P4 = high after P3 (> P1 ideally) | P5 = new low (< P3)
 */
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

  // Classification
  isPerfect: boolean;        // line 3-4 inside channel 1-2, P5 > P3 (bearish) or P5 < P3 (bullish)
  shape: 'perfect' | 'fat_mw' | 'long_neck' | 'imperfect'; // Alba's shape taxonomy
  isDoubleWolfe: boolean;

  // Key levels (computed)
  entryPrice: number;        // P5 area (enter immediately on identification)
  stopLoss: number;          // just beyond P5
  target1: number;           // 23.6% Fibonacci P2→P3
  target2: number;           // 61.8% Fibonacci P2→P3
  target3?: number;          // 100% Fibonacci (only fat M/W shapes)
  target4?: number;          // 161.8% Fibonacci extension (fat M/W)
  line14Price?: number;      // price on line 1-4 at entry time (Bill Wolfe objective)

  // EMA50 reference at detection time
  ema50: number;
  macdHistogram?: number;

  detectedAt: number;        // unix ms
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
  quantity: number;          // base asset qty
  usdAmount: number;         // USD value of position

  stopLoss: number;
  target1: number;
  target2: number;
  target3?: number;
  target4?: number;

  // Partial close tracking
  closedQty1: number;        // qty closed at TP1 (50% default)
  closedQty2: number;
  closedQty3: number;
  closedQty4: number;

  exitPrice?: number;
  exitTime?: number;
  closeReason?: CloseReason;
  pnl?: number;              // realized PnL in USD
  pnlPct?: number;

  // Exchange order IDs (real mode)
  entryOrderId?: string;
  slOrderId?: string;
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

// ─── Price Feed ──────────────────────────────────────────────────────────────

/**
 * Abstraction over how current prices are delivered to the trade monitor.
 * - PollingPriceFeed: prices come from the candle scan cycle (default)
 * - WebSocketPriceFeed: prices stream in real-time from CoinEx WS
 */
export interface IPriceFeed {
  /** Start delivering prices. onPrice is called whenever a new price arrives. */
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
  // ── Risk management ──────────────────────────────────────────────────────
  maxOpenTradesTotal: number;     // 0 = unlimited
  maxOpenTradesPerSymbol: number; // 0 = unlimited
  maxDailyLossPct: number;        // e.g. 0.05 = pause bot when daily loss >= 5% of capital
  priceFeed: 'polling' | 'websocket';
}
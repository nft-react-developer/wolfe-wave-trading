import type { Candle, WolfeWave, WolfeDirection } from '../types';

// ─── Tipos del simulador ──────────────────────────────────────────────────────
// Estos tipos viven aparte de `src/types/index.ts` porque son específicos del
// backtest y no deben filtrarse al bot de producción.

export interface BacktestConfig {
  // Datos
  symbol:         string;
  timeframe:      string;
  candlesPath?:   string;            // archivo JSON cacheado; si no existe, lo descarga
  startTs?:       number;            // ms — desde cuándo replay (opcional)
  endTs?:         number;            // ms — hasta cuándo replay (opcional)

  // Capital / sizing
  initialCapital: number;            // ej. 10000
  riskPerTradePct: number;           // ej. 0.01 (1% del capital al riesgo)
  maxTradeUsd:    number;            // ej. 200 (capa absoluta)
  minOrderUsd:    number;            // ej. 30 (mínimo por trade)

  // Costos de operación (pesimista por defecto)
  feePctPerSide:  number;            // ej. 0.002 (0.2% taker CoinEx)
  slippagePct:    number;            // ej. 0.0005 (0.05% en market)
  spreadPct:      number;            // ej. 0.0005 (0.05% major, 0.0015 altcoin)

  // Reglas de simulación
  ambiguousCandleSlFirst: boolean;   // si SL y TP caen en misma vela → SL primero
  entryMode:      'market_at_p5' | 'confirm_candle' | 'limit_at_p5';
  entryConfirmWindowCandles: number; // velas máximas para 'confirm_candle' / 'limit_at_p5'

  // Filtros opcionales (todos detrás de flag para A/B testing)
  filters: BacktestFilters;

  // Solo bullish? (foco del usuario)
  onlyBullish:    boolean;

  // Cantidad mínima de velas previas a comenzar a detectar (warm-up)
  warmupCandles:  number;            // ej. 100
}

export interface BacktestFilters {
  // Volumen (§13 Alba)
  minP5VolumeRatio?:   number;       // off si undefined; sugerido 1.1
  volumeExitRatio?:    number;       // off si undefined; sugerido 1.2
  volumeWindow?:       number;       // promedio sobre N velas (default 20)

  // EMA50 (§3.c, §11)
  ema50DeadlineCandles?: number;     // off si undefined; sugerido 5

  // Forma / shape (§9)
  minShapeScore?:      number;       // off si undefined; sugerido 12 (cuello largo penalizado)

  // RR (estándar)
  minRrRatio?:         number;       // off si undefined; default lo lee el detector

  // Re-entrada en pullback (§3.b)
  reentryEnabled?:     boolean;
  reentryProximityPct?: number;      // 0.003 = 0.3% al rededor de P5
  reentrySlWidenFactor?: number;     // 1.5 = SL 1.5× más amplio en la 2da
  reentryMaxPerWave?:  number;       // default 1
  reentryWindowCandles?: number;     // default 10

  // Score agregado (futuro, ver §3 del MD)
  minTotalScore?:      number;

  // Cierre por mecha vs cierre de vela para SL
  useCloseBasedSL?:    boolean;      // §3 "sin volver a superar P5" → cierre, no mecha
}

// ─── Trade simulado ────────────────────────────────────────────────────────────

export type SimCloseReason =
  | 'tp1' | 'tp1.5' | 'tp2' | 'tp3' | 'tp4'
  | 'sl'
  | 'volume_exit'        // §13: vol post-P5 > vol P5
  | 'ema50_timeout'      // §11: no rompió EMA50 en N velas
  | 'reentry_sl'         // re-entrada cerrada en SL
  | 'timeout';           // límite de velas en trade (opcional)

export interface SimTrade {
  id:             number;
  waveId:         number;
  symbol:         string;
  timeframe:      string;
  direction:      WolfeDirection;
  shape:          WolfeWave['shape'];
  isPerfect:      boolean;
  isDoubleWolfe:  boolean;

  // Entry
  detectedAtIdx:  number;          // índice de la vela en que se detectó
  entryIdx:       number;          // índice de la vela en que se ejecutó la entrada
  entryPrice:     number;
  entryTime:      number;
  quantity:       number;
  usdAmount:      number;
  side:           'long' | 'short';

  // Niveles
  stopLoss:       number;          // SL corriente (puede moverse a BE tras TP1)
  initialStopLoss: number;         // SL original — para calcular 1R correctamente
  target1:        number;
  target15?:      number;
  target2:        number;
  target3?:       number;
  target4?:       number;
  line14Price?:   number;

  // P5 (necesario para filtros post-P5 como volumen exit)
  p5Index:        number;
  p5Price:        number;
  p5Volume:       number;

  // Resultados parciales
  closedQty1:     number;
  closedQty2:     number;
  closedQty3:     number;
  closedQty4:     number;
  hitTp1:         boolean;
  hitTp15:        boolean;
  hitTp2:         boolean;
  hitTp3:         boolean;
  hitTp4:         boolean;

  // Cierre
  exitIdx?:       number;
  exitPrice?:     number;
  exitTime?:      number;
  closeReason?:   SimCloseReason;

  // PnL bruto y neto (después de fees + slippage)
  grossPnl?:      number;
  netPnl?:        number;
  netPnlPct?:     number;
  rMultiple?:     number;          // pnl / risk inicial (1R)

  // Features para análisis post-hoc
  mfe?:           number;          // max favorable excursion (en R)
  mae?:           number;          // max adverse excursion (en R)
  candlesInTrade?: number;
  brokeEMA50?:    boolean;
  p5VolRatio?:    number;
  hasMacdDiv?:    boolean;
  reentryNumber?: number;          // 0 = primera entrada, 1 = re-entrada
}

// ─── Resultado agregado ────────────────────────────────────────────────────────

export interface BacktestResult {
  config:         BacktestConfig;
  symbol:         string;
  timeframe:      string;
  candleCount:    number;
  fromTs:         number;
  toTs:           number;

  trades:         SimTrade[];
  wavesDetected:  number;
  wavesFiltered:  number;          // detectadas pero descartadas por filtros

  // KPIs principales (calculados en metrics.ts)
  metrics:        BacktestMetrics;
}

export interface BacktestMetrics {
  totalTrades:        number;
  closedTrades:       number;
  winningTrades:      number;
  losingTrades:       number;
  winRate:            number;            // 0–1

  totalReturnPct:     number;            // sobre initialCapital
  finalEquity:        number;
  maxDrawdownPct:     number;
  maxDrawdownAbs:     number;

  cagr:               number;            // anualizada
  sharpe:             number;
  sortino:            number;
  calmar:             number;
  profitFactor:       number;
  expectancy:         number;            // R promedio por trade
  expectancyUsd:      number;            // USD promedio por trade
  avgWinR:            number;
  avgLossR:           number;
  avgRrRealized:      number;            // avgWin / avgLoss (signo positivo)

  avgCandlesInTrade:  number;
  tradesPerMonth:     number;

  // Por categoría (breakdowns)
  byShape:            Record<string, ShapeBucket>;
  byCloseReason:      Record<SimCloseReason | string, number>;
  byMonth:            Array<{ month: string; pnl: number; trades: number }>;
}

export interface ShapeBucket {
  trades:    number;
  winRate:   number;
  avgR:      number;
  totalPnl:  number;
}

// ─── Helpers de retorno del replay ─────────────────────────────────────────────

export interface ReplayEvent {
  type: 'wave_detected' | 'trade_opened' | 'trade_closed' | 'wave_filtered';
  candleIdx: number;
  wave?: WolfeWave;
  trade?: SimTrade;
  filterReason?: string;
}

export type CandleSeries = readonly Candle[];

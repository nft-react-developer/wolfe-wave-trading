import type { IExchange, IPriceFeed } from '../types';
import { detectWolfeWaves } from '../strategies/wolfeDetector';
import { saveWave, tradeAlreadyOpenForWave, waveAlreadyExists } from '../services/waveRepository';
import { TradeService, RiskGuard } from '../services/tradeManager';
import { PollingPriceFeed } from '../services/priceFeed';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { telegram } from './telegram';

export class Scanner {
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private tradeService: TradeService;
  private riskGuard: RiskGuard;
  private priceFeed: IPriceFeed;

  // Latest known price per symbol — updated by both polling and WS feeds
  private currentPrices: Record<string, number> = {};

  // Latest candle history per symbol — used for structure/ATR trailing stop
  private latestCandles: Record<string, import('../types').Candle[]> = {};

  constructor(private exchange: IExchange, priceFeed: IPriceFeed) {
    this.tradeService = new TradeService(exchange, config.tradingMode);
    this.riskGuard    = new RiskGuard(config.tradingMode);
    this.priceFeed    = priceFeed;
  }

  start() {
    if (this.running) return;
    this.running = true;

    logger.info('Scanner started', {
      mode:       config.tradingMode,
      symbols:    config.scanSymbols,
      timeframes: config.scanTimeframes,
      interval:   config.scanIntervalMs,
      priceFeed:  config.priceFeed,
    });

    // Start the price feed — onPrice is called whenever a new price arrives.
    // In polling mode this is a no-op (prices come from candles inside scan()).
    // In websocket mode this fires on every ticker update from CoinEx WS.
    this.priceFeed.start(config.scanSymbols, async (symbol, price) => {
      this.currentPrices[symbol] = price;

      // In websocket mode: monitor open trades immediately on every price tick
      // so SL/TP detection latency is milliseconds instead of up to 60 seconds.
      if (config.priceFeed === 'websocket') {
        try {
          await this.tradeService.checkOpenTrades({ [symbol]: price });
        } catch (err) {
          logger.error(`WS price handler error for ${symbol}`, err);
        }
      }
    });

    // Reconcile open trades on startup (real mode only), then start scan loop
    void this.tradeService.reconcileOpenTrades().then(() => {
      void this.scan();
      this.timer = setInterval(() => void this.scan(), config.scanIntervalMs);
    });
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.priceFeed.stop();
    logger.info('Scanner stopped');
  }

  /** Hot-update the list of symbols to scan — called by the symbol update cron */
  updateSymbols(symbols: string[]): void {
    config.scanSymbols = symbols;
    logger.info('Scanner: symbols updated', { symbols });
  }

  pause():    void    { this.riskGuard.pause();    }
  resume():   void    { this.riskGuard.resume();   }
  isPaused(): boolean { return this.riskGuard.isPaused(); }

  // ── Scan cycle ─────────────────────────────────────────────────────────────
  // Runs every SCAN_INTERVAL_MS regardless of price feed mode.
  // Responsibilities:
  //   1. Fetch candles and detect Wolfe Waves on all symbols/timeframes
  //   2. Update currentPrices (used by polling mode for trade monitoring)
  //   3. In polling mode only: call checkOpenTrades once per cycle

  private async scan() {
    logger.debug('Scan cycle started');

    await this.riskGuard.checkDailyDrawdown();
    const paused = this.riskGuard.isPaused();
    if (paused) {
      logger.warn('New trade detection paused by RiskGuard (daily loss limit)');
    }

    for (const symbol of config.scanSymbols) {
      for (const timeframe of config.scanTimeframes) {
        try {
          const candles = await this.exchange.getCandles(symbol, timeframe, 200);
          if (candles.length === 0) continue;

          // Update latest price and candle history
          const latestClose = candles[candles.length - 1].close;
          this.currentPrices[symbol] = latestClose;
          this.latestCandles[symbol]  = candles;

          // In polling mode: push price through the feed callback
          if (config.priceFeed === 'polling' && this.priceFeed instanceof PollingPriceFeed) {
            this.priceFeed.push(symbol, latestClose);
          }

          // Wave detection — skipped when bot is paused
          if (paused) continue;

          const waves = detectWolfeWaves(candles, symbol, timeframe);

          for (const wave of waves) {
            // En spot solo se pueden operar posiciones long (bullish)
            // Short requiere margin/futures
            if (config.tradingMode === 'real' && wave.direction === 'bearish') {
                continue;
            }

            const candleDurationMs = this.timeframeToMs(timeframe);

            // ── Filtro 1: recencia de P5 ──────────────────────────────────
            // Si P5 se formó hace más de MAX_P5_AGE_CANDLES velas, la onda
            // ya es demasiado vieja para entrar — el precio habrá avanzado
            // y la entrada óptima pasó. Evita que al arrancar el bot se
            // disparen trades en ondas que empezaron mientras estaba offline.
            const lastCandleTime = candles[candles.length - 1].timestamp;
            const p5AgeCandles   = (lastCandleTime - wave.p5.timestamp) / candleDurationMs;
            const maxP5Age       = this.maxP5AgeCandles(timeframe);

            if (p5AgeCandles > maxP5Age) {
              logger.debug('Wave skipped: P5 too old', {
                symbol, timeframe,
                p5AgeCandles: p5AgeCandles.toFixed(1),
                maxP5Age,
              });
              continue;
            }

            // ── Filtro 2: deriva de precio desde P5 ───────────────────────
            // Si el precio actual ya se alejó más de MAX_P5_DRIFT_PCT desde
            // el precio de P5, la entrada óptima pasó. Evita entradas tardías
            // en movimientos que ya recorrieron buena parte del camino.
            const priceDriftPct = Math.abs(latestClose - wave.p5.price) / wave.p5.price;
            const maxDrift      = this.maxP5DriftPct(timeframe);

            if (priceDriftPct > maxDrift) {
              logger.debug('Wave skipped: price drifted too far from P5', {
                symbol, timeframe,
                p5Price:      wave.p5.price,
                currentPrice: latestClose,
                driftPct:     (priceDriftPct * 100).toFixed(2) + '%',
                maxDriftPct:  (maxDrift * 100).toFixed(2) + '%',
              });
              continue;
            }

            const exists = await waveAlreadyExists(wave, candleDurationMs * 5);
            if (exists) continue;

            const waveId = await saveWave(wave);

            // // Telegram wave notification disabled — only daily report is sent
            // await telegram.notifyWaveDetected({
            //   symbol: wave.symbol,
            //   timeframe: wave.timeframe,
            //   direction: wave.direction,
            //   shape: wave.shape,
            //   isPerfect: wave.isPerfect,
            //   entryPrice: wave.entryPrice,
            //   stopLoss: wave.stopLoss,
            //   target1: wave.target1,
            //   target2: wave.target2,
            //   target3: wave.target3,
            //   ema50: wave.ema50,
            // });

            const hasOpenTrade = await tradeAlreadyOpenForWave(wave, candleDurationMs * 10);
            if (hasOpenTrade) {
              logger.info('Trade skipped: already have an open trade for this wave', {
                symbol: wave.symbol,
                direction: wave.direction,
                p5: wave.p5.price,
              });
              continue;
            }

            const riskCheck = await this.riskGuard.canOpenTrade(wave.symbol);
            if (!riskCheck.allowed) {
              logger.warn(`Trade skipped: ${riskCheck.reason}`, { symbol: wave.symbol });
              continue;
            }

            const availableCapital = await this.getAvailableCapital();
            const tradeOpened = await this.tradeService.openTrade(wave, waveId, availableCapital);

            if (tradeOpened) {
              await telegram.notifyTradeOpened({
                id: tradeOpened.id,
                symbol: tradeOpened.symbol,
                side: tradeOpened.side,
                entryPrice: tradeOpened.entryPrice,
                stopLoss: tradeOpened.stopLoss,
                target1: tradeOpened.target1,
                target2: tradeOpened.target2,
                usdAmount: tradeOpened.usdAmount,
                quantity: tradeOpened.quantity,
                mode: tradeOpened.mode,
              });
            }
          }
        } catch (err) {
          logger.error(`Error scanning ${symbol}/${timeframe}`, err);
        }
      }
    }

    // In polling mode: monitor open trades once per scan cycle.
    // In websocket mode: trade monitoring already happens per-tick above,
    // so we skip it here to avoid double-evaluation.
    if (config.priceFeed === 'polling') {
      try {
        await this.tradeService.checkOpenTrades(this.currentPrices, this.latestCandles);
      } catch (err) {
        logger.error('Error checking open trades', err);
      }
    }

    logger.debug('Scan cycle complete');
  }

  // ── Filtros de entrada ─────────────────────────────────────────────────────

  /**
   * Máximo número de velas que puede tener P5 de antigüedad para entrar.
   * En timeframes cortos el patrón se invalida rápido; en timeframes largos
   * es normal que P5 se haya formado hace 2-3 velas antes de la detección.
   *
   * Nota: el detector ya exige que P5 sea el último pivot del array, así que
   * en condiciones normales P5 siempre tendrá pocos candles de antigüedad.
   * Este filtro es principalmente un escudo de arranque (bot offline → bot online).
   */
  private maxP5AgeCandles(timeframe: string): number {
    const map: Record<string, number> = {
      '1min':  3,
      '3min':  3,
      '5min':  3,
      '15min': 3,
      '30min': 3,
      '1hour': 2,
      '2hour': 2,
      '4hour': 2,
      '6hour': 2,
      '12hour':2,
      '1day':  2,
    };
    return map[timeframe] ?? 3;
  }

  /**
   * Máxima deriva porcentual permitida del precio actual respecto a P5.
   * Si el precio ya se alejó más de este % desde P5, la onda está en marcha
   * y la relación riesgo/beneficio de la entrada ya no es favorable.
   *
   * Se escala con el timeframe: en 1min el mercado se mueve poco entre velas,
   * en 4H puede haber movimientos del 3-5% intra-vela sin que la onda invalide.
   */
  private maxP5DriftPct(timeframe: string): number {
    const map: Record<string, number> = {
      '1min':  0.004,   // 0.4%
      '3min':  0.005,   // 0.5%
      '5min':  0.006,   // 0.6%
      '15min': 0.010,   // 1.0%
      '30min': 0.015,   // 1.5%
      '1hour': 0.020,   // 2.0%
      '2hour': 0.025,   // 2.5%
      '4hour': 0.030,   // 3.0%
      '6hour': 0.035,   // 3.5%
      '12hour':0.040,   // 4.0%
      '1day':  0.050,   // 5.0%
    };
    return map[timeframe] ?? 0.015;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async getAvailableCapital(): Promise<number> {
    const balance = await this.exchange.getBalance();
    return balance['USDT'] ?? 0;
  }

  private timeframeToMs(tf: string): number {
    const map: Record<string, number> = {
      '1min':  60_000,
      '3min':  180_000,
      '5min':  300_000,
      '15min': 900_000,
      '30min': 1_800_000,
      '1hour': 3_600_000,
      '2hour': 7_200_000,
      '4hour': 14_400_000,
      '1day':  86_400_000,
    };
    return map[tf] ?? 3_600_000;
  }
}
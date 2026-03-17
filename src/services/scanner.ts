import type { IExchange, IPriceFeed } from '../types';
import { detectWolfeWaves } from '../strategies/wolfeDetector';
import { saveWave, waveAlreadyExists } from '../services/waveRepository';
import { TradeService, RiskGuard } from '../services/tradeManager';
import { PollingPriceFeed } from '../services/priceFeed';
import { config } from '../utils/config';
import { logger } from '../utils/logger';

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
            const candleDurationMs = this.timeframeToMs(timeframe);
            const exists = await waveAlreadyExists(wave, candleDurationMs * 5);
            if (exists) continue;

            const waveId = await saveWave(wave);

            const riskCheck = await this.riskGuard.canOpenTrade(wave.symbol);
            if (!riskCheck.allowed) {
              logger.warn(`Trade skipped: ${riskCheck.reason}`, { symbol: wave.symbol });
              continue;
            }

            const availableCapital = await this.getAvailableCapital();
            await this.tradeService.openTrade(wave, waveId, availableCapital);
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
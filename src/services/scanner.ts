import type { IExchange } from '../types';
import { detectWolfeWaves } from '../strategies/wolfeDetector';
import { saveWave, waveAlreadyExists } from '../services/waveRepository';
import { TradeService, RiskGuard } from '../services/tradeManager';
import { telegram } from '../services/telegram';
import { config } from '../utils/config';
import { logger } from '../utils/logger';
import { getDb, schema } from '../db/connection';
import { eq, and } from 'drizzle-orm';

const { trades } = schema;

export class Scanner {
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private tradeService: TradeService;

  private riskGuard: RiskGuard;

  constructor(private exchange: IExchange) {
    this.tradeService = new TradeService(exchange, config.tradingMode);
    this.riskGuard = new RiskGuard(config.tradingMode);
  }

  start() {
    if (this.running) return;
    this.running = true;
    logger.info(`Scanner started`, {
      mode: config.tradingMode,
      symbols: config.scanSymbols,
      timeframes: config.scanTimeframes,
      interval: config.scanIntervalMs,
    });

    // In real mode: reconcile open trades against the exchange before
    // the first scan so any fills that happened while the bot was down
    // are reflected in the DB before we start evaluating prices again.
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
    logger.info('Scanner stopped');
  }

  pause(): void  { this.riskGuard.pause();  }
  resume(): void { this.riskGuard.resume(); }
  isPaused(): boolean { return this.riskGuard.isPaused(); }

  private async scan() {
    logger.debug('Scan cycle started');

    // Check daily drawdown — pauses new trade detection if limit is exceeded
    await this.riskGuard.checkDailyDrawdown();
    const paused = this.riskGuard.isPaused();
    if (paused) {
      logger.warn('New trade detection paused by RiskGuard (daily loss limit)');
    }

    // Collect current prices for trade monitoring
    const currentPrices: Record<string, number> = {};

    for (const symbol of config.scanSymbols) {
      for (const timeframe of config.scanTimeframes) {
        try {
          const candles = await this.exchange.getCandles(symbol, timeframe, 200);
          if (candles.length === 0) continue;

          // Track latest price
          const latestClose = candles[candles.length - 1].close;
          currentPrices[symbol] = latestClose;

          // Detect Wolfe Waves — skipped when bot is paused
          if (paused) continue;

          const waves = detectWolfeWaves(candles, symbol, timeframe);

          for (const wave of waves) {
            // Dedup: skip if very similar wave already saved recently
            const candleDurationMs = this.timeframeToMs(timeframe);
            const exists = await waveAlreadyExists(wave, candleDurationMs * 5);
            if (exists) continue;

            // Save wave to DB
            const waveId = await saveWave(wave);

            // Telegram wave notification disabled — only daily report is sent
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

            // Risk checks before opening a trade
            const riskCheck = await this.riskGuard.canOpenTrade(wave.symbol);
            if (!riskCheck.allowed) {
              logger.warn(`Trade skipped: ${riskCheck.reason}`, { symbol: wave.symbol });
              continue;
            }

            // Open trade
            const availableCapital = await this.getAvailableCapital();
            const trade = await this.tradeService.openTrade(wave, waveId, availableCapital);

            // Telegram trade notification disabled — only daily report is sent
            // if (trade) {
            //   await telegram.notifyTradeOpened({
            //     id: trade.id,
            //     symbol: trade.symbol,
            //     side: trade.side,
            //     entryPrice: trade.entryPrice,
            //     stopLoss: trade.stopLoss,
            //     target1: trade.target1,
            //     target2: trade.target2,
            //     usdAmount: trade.usdAmount,
            //     quantity: trade.quantity,
            //     mode: trade.mode,
            //   });
            // }
          }
        } catch (err) {
          logger.error(`Error scanning ${symbol}/${timeframe}`, err);
        }
      }
    }

    // Monitor existing open trades
    try {
      await this.tradeService.checkOpenTrades(currentPrices);
    } catch (err) {
      logger.error('Error checking open trades', err);
    }

    logger.debug('Scan cycle complete');
  }

  private async getAvailableCapital(): Promise<number> {
    try {
      const balance = await this.exchange.getBalance();
      return balance['USDT'] ?? config.initialCapital;
    } catch {
      return config.initialCapital;
    }
  }

  private timeframeToMs(tf: string): number {
    const map: Record<string, number> = {
      '1min': 60_000,
      '3min': 180_000,
      '5min': 300_000,
      '15min': 900_000,
      '30min': 1_800_000,
      '1hour': 3_600_000,
      '2hour': 7_200_000,
      '4hour': 14_400_000,
      '1day': 86_400_000,
    };
    return map[tf] ?? 3_600_000;
  }
}
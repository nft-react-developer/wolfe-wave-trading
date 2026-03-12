import * as dotenv from 'dotenv';
import { AppConfig } from '../types';


dotenv.config();

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

function parseList(raw: string | undefined, fallback: string[]): string[] {
  if (!raw) return fallback;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export function loadConfig(): AppConfig {
  const mode = (process.env.TRADING_MODE ?? 'paper') as 'paper' | 'real';

  const initialCapital = Number(process.env.INITIAL_CAPITAL ?? 10000);
  const maxTradePct = Number(process.env.MAX_TRADE_PCT ?? 0.02);
  const maxTradeAmountEnv = Number(process.env.MAX_TRADE_AMOUNT ?? 200);

  // The actual max per-trade is the lesser of the absolute cap and the % cap
  const maxTradeAmount = Math.min(maxTradeAmountEnv, initialCapital * maxTradePct);

  return {
    tradingMode: mode,
    initialCapital,
    maxTradeAmount,
    maxTradePct,
    scanTimeframes: parseList(process.env.SCAN_TIMEFRAMES, ['15min', '1hour', '4hour']),
    scanSymbols: parseList(process.env.SCAN_SYMBOLS, ['BTCUSDT', 'ETHUSDT']),
    scanIntervalMs: Number(process.env.SCAN_INTERVAL_MS ?? 60_000),
    macd: {
      fast: Number(process.env.MACD_FAST ?? 9),
      slow: Number(process.env.MACD_SLOW ?? 18),
      signal: Number(process.env.MACD_SIGNAL ?? 9),
    },
    emaPeriod: Number(process.env.EMA_PERIOD ?? 50),
    apiPort: Number(process.env.API_PORT ?? 3000),
    dailyReportCron: process.env.DAILY_REPORT_CRON ?? '0 8 * * *',
  };
}

export const config = loadConfig();

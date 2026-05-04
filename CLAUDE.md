# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Development with hot reload (tsx watch src/index.ts)
npm start            # Run via tsx (not compiled — same runtime as dev)
npm run build        # Compile TypeScript to dist/ (type-check only in practice)

npm run db:generate  # Generate Drizzle migration files
npm run db:migrate   # Apply pending migrations
npm run db:push      # Push schema directly to DB (dev only, skips migration files)
npm run db:studio    # Open Drizzle Studio UI at localhost:4983
```

There are no test commands in this project. `npm run build` (`tsc`) is the only static check available — run it after changes to catch type errors.

**External dependency:** `utils/chartRenderer.ts` spawns `python3 wolfe_chart.py` to render wave PNGs. Python 3 must be installed and `wolfe_chart.py` must exist alongside the compiled output.

## Architecture Overview

**Wolfe Wave Trading Bot** — automated crypto trading on CoinEx, implementing the Alba Puerro Wolfe Wave methodology. Node.js + TypeScript + Drizzle ORM + MySQL.

### Entry Point & Startup (`src/index.ts`)
Startup sequence:
1. Telegram polling → DB connection → Exchange instance → Price feed
2. `Scanner` starts the main detection loop
3. `Scheduler` registers two cron jobs (daily reports, symbol volume updates)
4. Express REST API starts (default port `3000`, set via `API_PORT`)
5. SIGINT/SIGTERM → graceful shutdown (stops scanner, stops Telegram polling, closes DB)

### Core Data Flow
```
Scanner (every SCAN_INTERVAL_MS)
  → Exchange.getCandles()
  → wolfeDetector.detectWolfeWaves()        — returns validated WolfeWave[]
  → waveRepository: deduplicate + persist
  → telegram.notifyWaveDetected()           — sends chart image + inline "Open Trade" button
  → RiskGuard.canOpenTrade()
  → TradeService.openTrade()
      → Exchange: place market entry + stop order
      → telegram.notifyTradeOpened()

priceFeed (per-tick or per-scan-cycle)
  → TradeService.checkOpenTrades()
      → evaluateTrade(): SL / TP1 partial close / trailing stop / TP2/TP3/TP4
```

### Key Modules

| File | Purpose |
|------|---------|
| `strategies/wolfeDetector.ts` | Core pattern detection: 5-point pivot validation, shape classification, Fibonacci targets, MACD divergence filter, RR ratio check |
| `services/scanner.ts` | Main loop: candle fetching, wave detection, deduplication gate, risk checks, trade opening |
| `services/tradeManager.ts` | Three classes: `TradeService` (full lifecycle), `RiskGuard` (limits + drawdown), position sizing |
| `services/exchange.ts` | `CoinExExchange` (live REST) + `PaperExchange` (simulator) — both implement `IExchange` |
| `services/priceFeed.ts` | `PollingPriceFeed` (push price once per scan cycle) and `WebSocketPriceFeed` (per-tick CoinEx stream) |
| `services/waveRepository.ts` | Wave persistence + deduplication (0.1% price window, 3-candle time window) |
| `services/telegram.ts` | Notifications with inline keyboard buttons; `initTelegramPolling()` must be called at startup to receive callback queries |
| `services/statistics.ts` | Wave/trade stats, equity curves, daily summaries for API + scheduler |
| `services/symbolSelector.ts` | Snapshots daily CoinEx volumes → `getTopSymbols()` for dynamic symbol lists |
| `utils/indicators.ts` | EMA, MACD, Fibonacci, pivot detection, line projection |
| `utils/chartRenderer.ts` | Spawns Python renderer, returns PNG `Buffer` or `null` on failure (never throws) |
| `utils/config.ts` | Reads and validates all env vars, applies defaults |
| `api/routes.ts` | 16+ Express endpoints; also wires `GET /test/wave-chart` for manual chart testing |
| `db/schema.ts` | Drizzle schema: `wolfe_waves`, `trades`, `account_snapshots`, `symbol_volume` |

### Pattern Detection (`wolfeDetector.ts`)

The detector requires ≥60 candles (EMA50 warm-up + MACD slow period). Key decisions:

- **Entry is immediate at P5** — no waiting for line 1-3 crossover (75% of waves never cross it)
- **Stop loss** = P5 ± buffer (10% of P5→P3 leg, capped at 2%, but floored at a per-timeframe minimum: 0.4% on 1min up to 5% on 1day)
- **Pivot strength** scales with timeframe (2 candles on 1min → 7 on 1day) to filter noise
- **RR ratio** is checked against TP2 (61.8%) — must meet `MIN_RR_RATIO` (default 2)
- Only waves where **P5 is the most recent pivot** are acted on (prevents trading stale patterns)

**Shape classification affects TP structure:**
- `perfect` / `long_neck` / `imperfect`: close 50% at TP1, remaining 50% at TP2
- `fat_mw`: close 50% at TP1, 25% at TP2, 12.5% at TP3, remainder at TP4

### Trade Lifecycle (`tradeManager.ts`)

**Position sizing:** `riskAmount = min(capital × 1%, MAX_TRADE_AMOUNT)` → `qty = riskAmount / |entry - SL|`. Minimum order: $30 USD.

**Stop loss enforcement (real mode):** A native exchange stop order is placed as a crash-safety net. Software monitoring is the primary trigger — the code does NOT poll `getStopOrder()` every tick to avoid CoinEx API lag causing false positives.

**Startup reconciliation (real mode only):** `reconcileOpenTrades()` runs on startup to sync any fills that occurred while the bot was offline (SL hit, partial closes, cancellations).

**Trailing stop methods** (activate after TP1 hit):
- `structure`: trails below the lowest low (or highest high for shorts) of the last N candles
- `percentage`: fixed % offset from best price
- `atr`: ATR-multiple offset from best price

### Telegram Integration

`initTelegramPolling()` is called at startup and enables receiving inline keyboard callback queries. The `notifyWaveDetected()` message includes a **🚀 Open Trade** button with `callback_data: open_trade:<waveId>`. The callback handler currently logs to console — the trade-opening logic is not yet wired.

### Configuration (`.env`)

```
TRADING_MODE=paper|real
INITIAL_CAPITAL=10000
MAX_TRADE_AMOUNT=200
MAX_TRADE_PCT=0.02
MIN_RR_RATIO=2
SCAN_SYMBOLS=BTCUSDT,ETHUSDT,SOLUSDT
SCAN_TIMEFRAMES=15min,30min,1hour,4hour
SCAN_INTERVAL_MS=60000
PRICE_FEED=polling|websocket
TRAILING_STOP_METHOD=structure|percentage|atr
TRAILING_STOP_LOOKBACK=5
TRAILING_STOP_PCT=0.015
TRAILING_STOP_MIN_MOVE=0.003
MAX_OPEN_TRADES_TOTAL=0       # 0 = unlimited
MAX_OPEN_TRADES_PER_SYMBOL=0
MAX_DAILY_LOSS_PCT=0.05
MACD_FAST=9
MACD_SLOW=18
MACD_SIGNAL=9
EMA_PERIOD=50
API_PORT=3000
DAILY_REPORT_CRON=0 8 * * *
SYMBOL_UPDATE_CRON=5 0 * * *
UPDATE_SYMBOLS_ON_STARTUP=false
COINEX_ACCESS_ID=...
COINEX_SECRET_KEY=...
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

### REST API
Base: `http://localhost:3000/api`

- Waves: `GET /waves`, `GET /waves/:id`, `GET /waves/stats/summary`
- Trades: `GET /trades`, `GET /trades/open`, `GET /trades/:id`, `GET /trades/stats/summary`, `POST /trades/close-all`
- Stats: `GET /stats/daily`, `GET /stats/today`, `GET /stats/performance`, `GET /stats/pnl-by-period`
- Account: `GET /account/balance`
- Bot control: `GET /bot/status`, `POST /bot/pause`, `POST /bot/resume`, `PATCH /config`
- Utilities: `GET /test/wave-chart`

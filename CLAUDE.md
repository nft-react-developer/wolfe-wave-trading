# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev          # Development with hot reload (tsx watch)
npm start            # Production run (compiled dist/)
npm run build        # Compile TypeScript to dist/

npm run db:generate  # Generate Drizzle migration files
npm run db:migrate   # Apply pending migrations
npm run db:push      # Push schema directly to DB (dev only)
npm run db:studio    # Open Drizzle Studio UI
```

There are no test commands in this project.

## Architecture Overview

**Wolfe Wave Trading Bot** — automated crypto trading on CoinEx, implementing the Alba Puerro Wolfe Wave methodology. Uses Node.js + TypeScript + Drizzle ORM + MariaDB.

### Entry Point & Startup (`src/index.ts`)
Wires together the full pipeline:
1. DB connection → Exchange instance (real or paper) → Price feed (polling or WebSocket)
2. `Scanner` starts the main detection loop
3. `Scheduler` registers cron jobs (daily reports, symbol updates)
4. Express REST API starts on port `6544`
5. SIGINT/SIGTERM handlers for graceful shutdown

### Core Data Flow
```
Scanner (every SCAN_INTERVAL_MS)
  → Exchange: fetch OHLCV candles
  → wolfeDetector: detect 5-point wave pattern
  → waveRepository: persist + deduplicate to DB
  → tradeManager + RiskGuard: open position if checks pass
  → priceFeed: monitors price → tradeManager: partial closes, SL, trailing stop
```

### Key Modules

| File | Purpose |
|------|---------|
| `strategies/wolfeDetector.ts` | Core pattern logic — identifies 5-point waves, classifies shape (perfect/fat_mw/long_neck/imperfect), detects double Wolfe, computes Fibonacci targets |
| `services/scanner.ts` | Main scan loop; coordinates candle fetching, wave detection, and open-trade monitoring |
| `services/tradeManager.ts` | Full trade lifecycle: entry, partial closes at TP1/TP2/TP3/TP4, trailing stop, stop loss |
| `services/exchange.ts` | CoinEx REST client + `PaperExchange` simulator — both implement `IExchange` interface |
| `services/priceFeed.ts` | `PollingPriceFeed` (passive) and `WebSocketPriceFeed` (active CoinEx stream) |
| `services/waveRepository.ts` | Wave persistence + deduplication (0.1% price window, 3-candle time window) |
| `services/statistics.ts` | Performance reports: wave/trade stats, equity curves, daily summaries |
| `services/riskGuard.ts` | Enforces max open trades, daily loss limits, pause/resume state |
| `utils/indicators.ts` | EMA, MACD, Fibonacci levels, line projection, MACD divergence |
| `utils/config.ts` | Loads and validates all environment variables |
| `api/routes.ts` | 16 Express endpoints for monitoring and runtime control |
| `db/schema.ts` | Drizzle schema: `wolfe_waves`, `trades`, `account_snapshots` |

### Trading Logic
- **Entry**: At P5 (the 5th point of the wave pattern)
- **Stop Loss**: Just beyond P5
- **Targets**: Fibonacci levels — TP1 (23.6%), TP2 (61.8%), TP3 (100%), TP4 (161.8%)
- **Partial closes**: 50% at TP1, remainder at TP2/TP3/TP4; stop moves to break-even after TP1
- **Trailing stop methods**: `structure` (candle-based), `percentage`, `atr` — set via `TRAILING_STOP_METHOD`
- **Filters**: EMA50 trend alignment, MACD divergence at P5

### Configuration (`.env`)
Key variables:

```
TRADING_MODE=paper|real
INITIAL_CAPITAL=500
MAX_TRADE_AMOUNT=50
MAX_TRADE_PCT=0.07
MIN_RR_RATIO=2
SCAN_SYMBOLS=BTCUSDT,ETHUSDT,SOLUSDT
SCAN_TIMEFRAMES=15min,30min,1hour,4hour
SCAN_INTERVAL_MS=15000
PRICE_FEED=polling|websocket
TRAILING_STOP_METHOD=structure|percentage|atr
MAX_OPEN_TRADES_TOTAL=0       # 0 = unlimited
MAX_OPEN_TRADES_PER_SYMBOL=0
MAX_DAILY_LOSS_PCT=0.1
MACD_FAST=9
MACD_SLOW=18
MACD_SIGNAL=9
EMA_PERIOD=50
COINEX_ACCESS_ID=...
COINEX_SECRET_KEY=...
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

### REST API
Base: `http://localhost:6544/api`

- Waves: `GET /waves`, `GET /waves/:id`, `GET /waves/stats/summary`
- Trades: `GET /trades`, `GET /trades/open`, `GET /trades/:id`, `GET /trades/stats/summary`, `POST /trades/close-all`
- Stats: `GET /stats/daily`, `GET /stats/today`, `GET /stats/performance`, `GET /stats/pnl-by-period`
- Account: `GET /account/balance`
- Bot control: `GET /bot/status`, `POST /bot/pause`, `POST /bot/resume`, `PATCH /config`
- Utilities: `GET /test/wave-chart`

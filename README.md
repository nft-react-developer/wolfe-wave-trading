# 🌊 Wolfe Wave Trading System

> Automated trading bot implementing the **Wolfe Wave methodology by Alba Puerro**, built with Node.js + TypeScript + Drizzle ORM + MariaDB.

---

## 📐 Strategy Overview

The system detects and trades **Wolfe Waves** (5-point counter-trend patterns) following Alba Puerro's extended methodology:

### Wave Structure
- **Bullish (M shape)**: P2=high, P1=prior low, P3=next low, P4=next high (>P1 ideally), P5=lowest low (<P3) → go **LONG**
- **Bearish (W shape)**: P2=low, P1=prior high, P3=next high, P4=next low (<P1 ideally), P5=highest high (>P3) → go **SHORT**

### Entry (Alba's modification)
- **Immediate entry at P5** (does NOT wait for line 1-3 crossover — 75% of waves never cross it)
- Stop Loss placed just beyond P5 with a buffer (10% of last leg)

### Targets (Fibonacci P2→P3)
| Target | Level    | Action                    |
|--------|----------|---------------------------|
| TP1    | 23.6%    | Close 50%, move SL to BE  |
| TP2    | 61.8%    | Close remaining (standard)|
| TP3    | 100%     | Fat M/W only              |
| TP4    | 161.8%   | Fat M/W extension         |

### Shape Classification
| Shape      | Success Rate | Notes                          |
|------------|-------------|--------------------------------|
| perfect    | ~75%        | Lines 3-4 inside channel 1-2  |
| fat_mw     | ~75-85%     | Near-horizontal, P5≈P3 level  |
| long_neck  | ~50-60%     | Long neck relative to body     |
| imperfect  | ~52%        | Falls outside channel          |

### Filters (additional confirmations)
- **EMA50**: acts as resistance/support — notes proximity
- **MACD (9-18-9)**: divergence at P5 = stronger entry signal
- **Double Wolfe**: triangle 3-4-5 of wave 1 = triangle 1-2-3 of wave 2 (~85% success)

---

## 🚀 Setup

### Prerequisites
- Node.js 18+
- MariaDB 10.7+
- CoinEx account (for real trading)
- Telegram Bot (for notifications)

### Installation

```bash
# 1. Clone and install
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your settings

# 3. Create the database
mysql -u root -p < setup.sql

# 4. Start the system
npm run dev          # development (with hot reload)
npm start            # production
```

---

## ⚙️ Environment Variables

### Core

| Variable              | Default             | Description                                  |
|----------------------|---------------------|----------------------------------------------|
| `TRADING_MODE`       | `paper`             | `paper` or `real`                            |
| `INITIAL_CAPITAL`    | `10000`             | Starting balance in USD                      |
| `MAX_TRADE_AMOUNT`   | `200`               | Max USD per trade (absolute cap)             |
| `MAX_TRADE_PCT`      | `0.02`              | Max % of capital per trade (e.g. 0.02 = 2%) |
| `SCAN_SYMBOLS`       | `BTCUSDT,ETHUSDT`   | Comma-separated symbols to scan              |
| `SCAN_TIMEFRAMES`    | `15min,1hour,4hour` | Comma-separated timeframes                   |
| `SCAN_INTERVAL_MS`   | `60000`             | How often to scan (milliseconds)             |
| `MACD_FAST`          | `9`                 | MACD fast EMA period                         |
| `MACD_SLOW`          | `18`                | MACD slow EMA period                         |
| `MACD_SIGNAL`        | `9`                 | MACD signal period                           |
| `EMA_PERIOD`         | `50`                | EMA period for trend filter                  |
| `DAILY_REPORT_CRON`  | `0 8 * * *`         | Cron for daily Telegram report (UTC)         |
| `API_PORT`           | `6544`              | REST API port                                |

### Risk Management

| Variable                    | Default | Description                                              |
|----------------------------|---------|----------------------------------------------------------|
| `MAX_OPEN_TRADES_TOTAL`    | `0`     | Max simultaneous open trades across all symbols (0 = unlimited) |
| `MAX_OPEN_TRADES_PER_SYMBOL` | `0`   | Max simultaneous open trades per symbol (0 = unlimited)  |
| `MAX_DAILY_LOSS_PCT`       | `0.05`  | Pause bot when daily loss reaches this % of capital (e.g. 0.05 = 5%) |

### Exchange & Notifications

| Variable              | Default | Description               |
|----------------------|---------|---------------------------|
| `COINEX_ACCESS_ID`   | —       | CoinEx API key            |
| `COINEX_SECRET_KEY`  | —       | CoinEx API secret         |
| `TELEGRAM_BOT_TOKEN` | —       | Telegram bot token        |
| `TELEGRAM_CHAT_ID`   | —       | Telegram chat/channel ID  |

---

## 🛡️ Risk Management

The bot enforces three automatic risk controls:

### 1. Max open trades (total)
If `MAX_OPEN_TRADES_TOTAL` is set, the bot skips opening any new trade once the limit is reached across all symbols. Already-open trades keep being monitored normally.

### 2. Max open trades per symbol
If `MAX_OPEN_TRADES_PER_SYMBOL` is set, the bot skips opening new trades for a specific symbol when that symbol already has the maximum number of open positions.

### 3. Daily drawdown limit
At the start of every scan cycle, the bot sums all realized PnL from trades closed since 00:00 UTC. If the total loss reaches `MAX_DAILY_LOSS_PCT` of `INITIAL_CAPITAL`, new trade detection is automatically paused for the rest of the day. The pause lifts automatically the next UTC day. Open trades continue to be monitored and closed normally even while paused.

All three limits can also be adjusted at runtime without restarting — see `PATCH /api/config` below.

---

## 📡 REST API Reference

Base URL: `http://localhost:6544/api`

### Health
```
GET /health
```

### Waves
```
GET /waves                    # List waves (filterable)
GET /waves/:id                # Wave detail + associated trades
GET /waves/stats/summary      # Wave detection statistics
```

**Query params for `/waves`:** `symbol`, `timeframe`, `direction`, `shape`, `from`, `to`, `limit`, `offset`

### Trades
```
GET /trades                   # List trades (filterable)
GET /trades/:id               # Trade detail + parent wave
GET /trades/open              # Currently open positions
GET /trades/stats/summary     # Trade performance statistics
```

**Query params for `/trades`:** `mode`, `status`, `symbol`, `timeframe`, `from`, `to`, `limit`, `offset`

### Statistics
```
GET /stats/today              # Today's PnL, trades opened/closed, waves detected
GET /stats/daily?days=30      # Equity curve (daily snapshots)
GET /stats/performance        # Combined waves + trades + ROI
GET /stats/pnl-by-period      # Daily PnL breakdown
```

### Account
```
GET /account/balance          # Live balance from exchange (real or paper)
```

### Bot Control
```
GET  /bot/status              # Current state: paused, mode, active risk config
POST /bot/pause               # Manually pause new trade detection
POST /bot/resume              # Resume after manual or automatic pause
```

`GET /bot/status` response example:
```json
{
  "paused": false,
  "mode": "paper",
  "config": {
    "maxTradeAmount": 200,
    "maxTradePct": 0.02,
    "maxOpenTradesTotal": 5,
    "maxOpenTradesPerSymbol": 2,
    "maxDailyLossPct": 0.05
  }
}
```

### Runtime Config
```
PATCH /config
```

Hot-updates risk and sizing parameters without restarting the process. **Changes are lost on restart** (not persisted to `.env`).

Accepted fields:

| Field                   | Description                          |
|------------------------|--------------------------------------|
| `maxTradeAmount`       | Max USD per trade                    |
| `maxTradePct`          | Max % of capital per trade           |
| `maxOpenTradesTotal`   | Max simultaneous open trades (total) |
| `maxOpenTradesPerSymbol` | Max open trades per symbol         |
| `maxDailyLossPct`      | Daily loss % threshold               |

Example — change the max trade amount to $150:
```
PATCH /api/config
Content-Type: application/json

{ "maxTradeAmount": 150 }
```

Response:
```json
{
  "updated": { "maxTradeAmount": 150 },
  "rejected": {}
}
```

---

## 📱 Telegram Notifications

Only the **daily report** is sent via Telegram (wave detected and trade opened notifications are disabled by default to reduce noise).

To re-enable individual notifications, uncomment the relevant blocks in `src/services/scanner.ts`.

---

## 📊 Database Schema

### `wolfe_waves`
Stores every detected wave with all 5 point prices/timestamps, shape classification, Fibonacci targets, and outcome flags (`reachedTarget1/2/3`, `hitStopLoss`).

### `trades`
Links to a wave; tracks entry/exit, partial closes at each TP, PnL, and (for real mode) exchange order IDs.

### `account_snapshots`
Daily balance snapshots used for the equity curve endpoint.

---

## 🔄 Restart Recovery (Real Mode)

On startup in real mode, the bot calls `reconcileOpenTrades()` before the first scan. For every trade marked `open` in the DB, it queries the exchange for the actual order status and syncs any fills that happened while the bot was offline (SL hit, TP1/TP2 filled, orders cancelled externally).

---

## 🗺️ Project Structure

```
src/
├── index.ts                  # Entry point
├── types/index.ts            # All TypeScript types
├── db/
│   ├── schema.ts             # Drizzle schema (waves, trades, snapshots)
│   └── connection.ts         # DB pool
├── utils/
│   ├── config.ts             # Env config loader
│   ├── indicators.ts         # EMA, MACD, Fibonacci, pivots
│   └── logger.ts             # Structured logger
├── strategies/
│   └── wolfeDetector.ts      # Core wave detection algorithm
├── services/
│   ├── exchange.ts           # CoinEx + Paper exchange adapters
│   ├── scanner.ts            # Main scan loop + pause/resume
│   ├── tradeManager.ts       # Trade lifecycle + RiskGuard
│   ├── waveRepository.ts     # Wave DB persistence + dedup
│   ├── statistics.ts         # Stats & reporting queries
│   ├── telegram.ts           # Telegram bot notifications
│   └── scheduler.ts          # Daily report cron
└── api/
    └── routes.ts             # Express REST API (16 endpoints)
```

---

## 🔌 Adding a New Exchange

Implement the `IExchange` interface in a new file under `src/services/`:

```typescript
export class HyperliquidExchange implements IExchange {
  getName() { return 'Hyperliquid'; }
  async getCandles(...) { ... }
  async placeOrder(...) { ... }
  async cancelOrder(...) { ... }
  async getOrder(...) { ... }
  async getBalance() { ... }
}
```

Then select it in `src/index.ts` based on an env variable.
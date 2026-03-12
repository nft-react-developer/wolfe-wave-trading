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
mysql -u root -p -e "CREATE DATABASE wolfe_trading CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

# 4. Run migrations
npm run db:push

# 5. Start the system
npm run dev          # development (with hot reload)
npm start            # production
```

---

## ⚙️ Environment Variables

| Variable             | Default            | Description                                   |
|---------------------|--------------------|-----------------------------------------------|
| `TRADING_MODE`      | `paper`            | `paper` (backtest) or `real` (live)           |
| `INITIAL_CAPITAL`   | `10000`            | Starting balance in USD                        |
| `MAX_TRADE_AMOUNT`  | `200`              | Max USD per trade (absolute cap)              |
| `MAX_TRADE_PCT`     | `0.02`             | Max % of capital per trade (e.g. 0.02 = 2%)  |
| `SCAN_SYMBOLS`      | `BTCUSDT,ETHUSDT`  | Comma-separated symbols to scan               |
| `SCAN_TIMEFRAMES`   | `15min,1hour,4hour`| Comma-separated timeframes                    |
| `SCAN_INTERVAL_MS`  | `60000`            | How often to scan (milliseconds)              |
| `MACD_FAST`         | `9`                | MACD fast EMA period                          |
| `MACD_SLOW`         | `18`               | MACD slow EMA period                          |
| `MACD_SIGNAL`       | `9`                | MACD signal period                            |
| `EMA_PERIOD`        | `50`               | EMA period for trend filter                   |
| `DAILY_REPORT_CRON` | `0 8 * * *`        | Cron for daily Telegram report (UTC)          |
| `API_PORT`          | `3000`             | REST API port                                 |

---

## 📡 REST API Reference

### Health
```
GET /api/health
```

### Waves
```
GET /api/waves                    # List waves (filterable)
GET /api/waves/:id                # Wave detail + associated trades
GET /api/waves/stats/summary      # Wave detection statistics
```

**Query params for `/api/waves`:**
- `symbol` — e.g. `BTCUSDT`
- `timeframe` — e.g. `1hour`
- `direction` — `bullish` | `bearish`
- `shape` — `perfect` | `fat_mw` | `long_neck` | `imperfect`
- `from` / `to` — ISO date strings
- `limit` / `offset` — pagination

### Trades
```
GET /api/trades                   # List trades (filterable)
GET /api/trades/:id               # Trade detail + parent wave
GET /api/trades/open              # Currently open positions
GET /api/trades/stats/summary     # Trade performance statistics
```

**Query params for `/api/trades`:**
- `mode` — `paper` | `real`
- `status` — `open` | `closed` | `cancelled`
- `symbol`, `timeframe`, `from`, `to`, `limit`, `offset`

### Statistics
```
GET /api/stats/today              # Today's report (PnL, trades, waves)
GET /api/stats/daily?days=30      # Equity curve (daily snapshots)
GET /api/stats/performance        # Combined waves + trades + ROI
GET /api/stats/pnl-by-period      # Daily PnL breakdown
```

---

## 📊 Database Schema

### `wolfe_waves`
Stores every detected wave with all 5 point prices/timestamps, shape classification, Fibonacci targets, and outcome flags (reachedTarget1/2/3, hitStopLoss).

### `trades`
Links to a wave; tracks entry/exit, partial closes at each TP, PnL, and (for real mode) exchange order IDs.

### `account_snapshots`
Daily balance snapshots used for the equity curve endpoint.

---

## 📱 Telegram Notifications

The bot sends:
- 🟢/🔴 **Wave detected** (symbol, direction, shape, all targets)
- 📈/📉 **Trade opened** (entry, SL, TP1, TP2, size)
- ✅/❌ **Trade closed** (reason, PnL)
- 📊 **Daily report** (sent at configured cron time)

---

## 🔄 Adding Hyperliquid

To add Hyperliquid later, create `src/services/hyperliquidExchange.ts` implementing the `IExchange` interface:

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

Then in `src/index.ts`, add:
```typescript
} else if (config.tradingMode === 'real' && process.env.EXCHANGE === 'hyperliquid') {
  exchange = new HyperliquidExchange();
}
```

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
│   ├── scanner.ts            # Main scan loop
│   ├── tradeManager.ts       # Trade lifecycle (open/monitor/close)
│   ├── waveRepository.ts     # Wave DB persistence + dedup
│   ├── statistics.ts         # Stats & reporting queries
│   ├── telegram.ts           # Telegram bot notifications
│   └── scheduler.ts          # Daily report cron
└── api/
    └── routes.ts             # Express REST API
```

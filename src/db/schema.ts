import {
  mysqlTable,
  int,
  varchar,
  decimal,
  bigint,
  boolean,
  text,
  mysqlEnum,
  timestamp,
  index,
} from 'drizzle-orm/mysql-core';

// ─── Wolfe Waves table ────────────────────────────────────────────────────────

export const wolfeWaves = mysqlTable(
  'wolfe_waves',
  {
    id: int('id').autoincrement().primaryKey(),

    symbol: varchar('symbol', { length: 20 }).notNull(),
    timeframe: varchar('timeframe', { length: 10 }).notNull(),
    direction: mysqlEnum('direction', ['bullish', 'bearish']).notNull(),

    // Point prices
    p1Price: decimal('p1_price', { precision: 20, scale: 8 }).notNull(),
    p2Price: decimal('p2_price', { precision: 20, scale: 8 }).notNull(),
    p3Price: decimal('p3_price', { precision: 20, scale: 8 }).notNull(),
    p4Price: decimal('p4_price', { precision: 20, scale: 8 }).notNull(),
    p5Price: decimal('p5_price', { precision: 20, scale: 8 }).notNull(),

    // Point timestamps (unix ms)
    p1Time: bigint('p1_time', { mode: 'number' }).notNull(),
    p2Time: bigint('p2_time', { mode: 'number' }).notNull(),
    p3Time: bigint('p3_time', { mode: 'number' }).notNull(),
    p4Time: bigint('p4_time', { mode: 'number' }).notNull(),
    p5Time: bigint('p5_time', { mode: 'number' }).notNull(),

    // Point candle indices
    p1Index: int('p1_index').notNull(),
    p2Index: int('p2_index').notNull(),
    p3Index: int('p3_index').notNull(),
    p4Index: int('p4_index').notNull(),
    p5Index: int('p5_index').notNull(),

    // Classification
    isPerfect: boolean('is_perfect').notNull().default(false),
    shape: mysqlEnum('shape', ['perfect', 'fat_mw', 'long_neck', 'imperfect'])
      .notNull()
      .default('imperfect'),
    isDoubleWolfe: boolean('is_double_wolfe').notNull().default(false),

    // Key levels
    entryPrice: decimal('entry_price', { precision: 20, scale: 8 }).notNull(),
    stopLoss: decimal('stop_loss', { precision: 20, scale: 8 }).notNull(),
    target1: decimal('target1', { precision: 20, scale: 8 }).notNull(),
    target2: decimal('target2', { precision: 20, scale: 8 }).notNull(),
    target3: decimal('target3', { precision: 20, scale: 8 }),
    target4: decimal('target4', { precision: 20, scale: 8 }),
    line14Price: decimal('line14_price', { precision: 20, scale: 8 }),

    // Indicators at detection
    ema50: decimal('ema50', { precision: 20, scale: 8 }).notNull(),
    macdHistogram: decimal('macd_histogram', { precision: 20, scale: 8 }),
    hasDivergence: boolean('has_divergence').notNull().default(false),

    // Outcome tracking
    reachedTarget1: boolean('reached_target1').notNull().default(false),
    reachedTarget2: boolean('reached_target2').notNull().default(false),
    reachedTarget3: boolean('reached_target3').notNull().default(false),
    hitStopLoss: boolean('hit_stop_loss').notNull().default(false),

    detectedAt: bigint('detected_at', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => ({
    symbolIdx: index('idx_waves_symbol').on(table.symbol),
    timeframeIdx: index('idx_waves_timeframe').on(table.timeframe),
    detectedIdx: index('idx_waves_detected').on(table.detectedAt),
    directionIdx: index('idx_waves_direction').on(table.direction),
  })
);

// ─── Trades table ─────────────────────────────────────────────────────────────

export const trades = mysqlTable(
  'trades',
  {
    id: int('id').autoincrement().primaryKey(),
    wolfeWaveId: int('wolfe_wave_id').notNull(),

    symbol: varchar('symbol', { length: 20 }).notNull(),
    timeframe: varchar('timeframe', { length: 10 }).notNull(),
    side: mysqlEnum('side', ['long', 'short']).notNull(),
    mode: mysqlEnum('mode', ['paper', 'real']).notNull(),
    status: mysqlEnum('status', ['open', 'closed', 'cancelled']).notNull().default('open'),

    entryPrice: decimal('entry_price', { precision: 20, scale: 8 }).notNull(),
    entryTime: bigint('entry_time', { mode: 'number' }).notNull(),
    quantity: decimal('quantity', { precision: 20, scale: 8 }).notNull(),
    usdAmount: decimal('usd_amount', { precision: 20, scale: 2 }).notNull(),

    stopLoss: decimal('stop_loss', { precision: 20, scale: 8 }).notNull(),
    target1: decimal('target1', { precision: 20, scale: 8 }).notNull(),
    target2: decimal('target2', { precision: 20, scale: 8 }).notNull(),
    target3: decimal('target3', { precision: 20, scale: 8 }),
    target4: decimal('target4', { precision: 20, scale: 8 }),

    // Partial closes
    closedQty1: decimal('closed_qty1', { precision: 20, scale: 8 }).notNull().default('0'),
    closedQty2: decimal('closed_qty2', { precision: 20, scale: 8 }).notNull().default('0'),
    closedQty3: decimal('closed_qty3', { precision: 20, scale: 8 }).notNull().default('0'),
    closedQty4: decimal('closed_qty4', { precision: 20, scale: 8 }).notNull().default('0'),

    exitPrice: decimal('exit_price', { precision: 20, scale: 8 }),
    exitTime: bigint('exit_time', { mode: 'number' }),
    closeReason: mysqlEnum('close_reason', ['tp1', 'tp2', 'tp3', 'tp4', 'sl', 'manual', 'timeout']),

    pnl: decimal('pnl', { precision: 20, scale: 2 }),
    pnlPct: decimal('pnl_pct', { precision: 10, scale: 4 }),

    // Exchange order IDs (null for paper trades)
    entryOrderId: varchar('entry_order_id', { length: 100 }),
    slOrderId: varchar('sl_order_id', { length: 100 }),
    tp1OrderId: varchar('tp1_order_id', { length: 100 }),
    tp2OrderId: varchar('tp2_order_id', { length: 100 }),

    notes: text('notes'),
    createdAt: timestamp('created_at').defaultNow(),
    updatedAt: timestamp('updated_at').defaultNow().onUpdateNow(),
  },
  (table) => ({
    symbolIdx: index('idx_trades_symbol').on(table.symbol),
    statusIdx: index('idx_trades_status').on(table.status),
    modeIdx: index('idx_trades_mode').on(table.mode),
    entryTimeIdx: index('idx_trades_entry_time').on(table.entryTime),
    wolfeIdx: index('idx_trades_wolfe').on(table.wolfeWaveId),
  })
);

// ─── Account Snapshots (daily balance history) ────────────────────────────────

export const accountSnapshots = mysqlTable(
  'account_snapshots',
  {
    id: int('id').autoincrement().primaryKey(),
    mode: mysqlEnum('mode', ['paper', 'real']).notNull(),
    date: varchar('date', { length: 10 }).notNull(), // YYYY-MM-DD
    balance: decimal('balance', { precision: 20, scale: 2 }).notNull(),
    dailyPnl: decimal('daily_pnl', { precision: 20, scale: 2 }).notNull().default('0'),
    cumulativePnl: decimal('cumulative_pnl', { precision: 20, scale: 2 }).notNull().default('0'),
    tradesOpened: int('trades_opened').notNull().default(0),
    tradesClosed: int('trades_closed').notNull().default(0),
    wavesDetected: int('waves_detected').notNull().default(0),
    winRate: decimal('win_rate', { precision: 5, scale: 2 }),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (table) => ({
    dateIdx: index('idx_snapshots_date').on(table.date),
    modeIdx: index('idx_snapshots_mode').on(table.mode),
  })
);


// ─── Symbol volumes ───────────────────────────────────────────────────────
export const symbolVolume = mysqlTable(
  'symbol_volume',
  {
    id:          int('id').autoincrement().primaryKey(),
    symbol:      varchar('symbol', { length: 20 }).notNull(),
    date:        varchar('date', { length: 10 }).notNull(),
    volumeUsdt:  decimal('volume_usdt', { precision: 30, scale: 2 }).notNull(),
    createdAt:   timestamp('created_at').defaultNow(),
  },
  (table) => ({
    symbolDateIdx: index('idx_sv_date').on(table.date),
    symbolIdx:     index('idx_sv_symbol').on(table.symbol),
  })
);

// ─── Type helpers ─────────────────────────────────────────────────────────────

export type WolfeWaveRow = typeof wolfeWaves.$inferSelect;
export type NewWolfeWaveRow = typeof wolfeWaves.$inferInsert;
export type TradeRow = typeof trades.$inferSelect;
export type NewTradeRow = typeof trades.$inferInsert;
export type AccountSnapshotRow = typeof accountSnapshots.$inferSelect;
export type NewAccountSnapshotRow = typeof accountSnapshots.$inferInsert;

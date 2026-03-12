-- ============================================================
--  Wolfe Wave Trading Bot — MariaDB 10.7
--  Ejecutar como root o usuario con permisos suficientes:
--    mysql -u root -p < setup.sql
-- ============================================================

CREATE DATABASE IF NOT EXISTS wolfe_trading
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE wolfe_trading;

-- ============================================================
--  1. wolfe_waves
-- ============================================================

CREATE TABLE IF NOT EXISTS wolfe_waves (
  id            INT            NOT NULL AUTO_INCREMENT PRIMARY KEY,

  -- Identificación
  symbol        VARCHAR(20)    NOT NULL,
  timeframe     VARCHAR(10)    NOT NULL,
  direction     ENUM('bullish','bearish') NOT NULL,

  -- Precios de los 5 puntos
  p1_price      DECIMAL(20,8)  NOT NULL,
  p2_price      DECIMAL(20,8)  NOT NULL,
  p3_price      DECIMAL(20,8)  NOT NULL,
  p4_price      DECIMAL(20,8)  NOT NULL,
  p5_price      DECIMAL(20,8)  NOT NULL,

  -- Timestamps Unix (ms) de cada punto
  p1_time       BIGINT         NOT NULL,
  p2_time       BIGINT         NOT NULL,
  p3_time       BIGINT         NOT NULL,
  p4_time       BIGINT         NOT NULL,
  p5_time       BIGINT         NOT NULL,

  -- Índices de vela dentro del array de candles
  p1_index      INT            NOT NULL,
  p2_index      INT            NOT NULL,
  p3_index      INT            NOT NULL,
  p4_index      INT            NOT NULL,
  p5_index      INT            NOT NULL,

  -- Clasificación de la onda
  is_perfect    TINYINT(1)     NOT NULL DEFAULT 0,
  shape         ENUM('perfect','fat_mw','long_neck','imperfect') NOT NULL DEFAULT 'imperfect',
  is_double_wolfe TINYINT(1)   NOT NULL DEFAULT 0,

  -- Niveles operativos
  entry_price   DECIMAL(20,8)  NOT NULL,
  stop_loss     DECIMAL(20,8)  NOT NULL,
  target1       DECIMAL(20,8)  NOT NULL,   -- Fib 23.6%
  target2       DECIMAL(20,8)  NOT NULL,   -- Fib 61.8%
  target3       DECIMAL(20,8)  NULL,       -- Fib 100%   (fat M/W)
  target4       DECIMAL(20,8)  NULL,       -- Fib 161.8% (fat M/W ext)
  line14_price  DECIMAL(20,8)  NULL,       -- Precio proyectado línea 1-4 en P5

  -- Indicadores en el momento de detección
  ema50         DECIMAL(20,8)  NOT NULL,
  macd_histogram DECIMAL(20,8) NULL,
  has_divergence TINYINT(1)    NOT NULL DEFAULT 0,

  -- Resultado
  reached_target1 TINYINT(1)  NOT NULL DEFAULT 0,
  reached_target2 TINYINT(1)  NOT NULL DEFAULT 0,
  reached_target3 TINYINT(1)  NOT NULL DEFAULT 0,
  hit_stop_loss   TINYINT(1)  NOT NULL DEFAULT 0,

  detected_at   BIGINT         NOT NULL,
  created_at    TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_waves_symbol    (symbol),
  INDEX idx_waves_timeframe (timeframe),
  INDEX idx_waves_detected  (detected_at),
  INDEX idx_waves_direction (direction)

) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ============================================================
--  2. trades
-- ============================================================

CREATE TABLE IF NOT EXISTS trades (
  id              INT            NOT NULL AUTO_INCREMENT PRIMARY KEY,
  wolfe_wave_id   INT            NOT NULL,

  symbol          VARCHAR(20)    NOT NULL,
  timeframe       VARCHAR(10)    NOT NULL,
  side            ENUM('long','short')          NOT NULL,
  mode            ENUM('paper','real')          NOT NULL,
  status          ENUM('open','closed','cancelled') NOT NULL DEFAULT 'open',

  entry_price     DECIMAL(20,8)  NOT NULL,
  entry_time      BIGINT         NOT NULL,
  quantity        DECIMAL(20,8)  NOT NULL,
  usd_amount      DECIMAL(20,2)  NOT NULL,

  stop_loss       DECIMAL(20,8)  NOT NULL,
  target1         DECIMAL(20,8)  NOT NULL,
  target2         DECIMAL(20,8)  NOT NULL,
  target3         DECIMAL(20,8)  NULL,
  target4         DECIMAL(20,8)  NULL,

  -- Cantidades cerradas parcialmente en cada TP
  closed_qty1     DECIMAL(20,8)  NOT NULL DEFAULT 0,
  closed_qty2     DECIMAL(20,8)  NOT NULL DEFAULT 0,
  closed_qty3     DECIMAL(20,8)  NOT NULL DEFAULT 0,
  closed_qty4     DECIMAL(20,8)  NOT NULL DEFAULT 0,

  exit_price      DECIMAL(20,8)  NULL,
  exit_time       BIGINT         NULL,
  close_reason    ENUM('tp1','tp2','tp3','tp4','sl','manual','timeout') NULL,

  pnl             DECIMAL(20,2)  NULL,
  pnl_pct         DECIMAL(10,4)  NULL,

  -- IDs de órdenes en el exchange (NULL en paper trading)
  entry_order_id  VARCHAR(100)   NULL,
  sl_order_id     VARCHAR(100)   NULL,
  tp1_order_id    VARCHAR(100)   NULL,
  tp2_order_id    VARCHAR(100)   NULL,

  notes           TEXT           NULL,
  created_at      TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_trades_symbol     (symbol),
  INDEX idx_trades_status     (status),
  INDEX idx_trades_mode       (mode),
  INDEX idx_trades_entry_time (entry_time),
  INDEX idx_trades_wolfe      (wolfe_wave_id),

  CONSTRAINT fk_trades_wave
    FOREIGN KEY (wolfe_wave_id) REFERENCES wolfe_waves (id)
    ON DELETE RESTRICT ON UPDATE CASCADE

) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;


-- ============================================================
--  3. account_snapshots  (histórico diario de balance)
-- ============================================================

CREATE TABLE IF NOT EXISTS account_snapshots (
  id               INT            NOT NULL AUTO_INCREMENT PRIMARY KEY,
  mode             ENUM('paper','real') NOT NULL,
  date             VARCHAR(10)    NOT NULL,   -- YYYY-MM-DD
  balance          DECIMAL(20,2)  NOT NULL,
  daily_pnl        DECIMAL(20,2)  NOT NULL DEFAULT 0,
  cumulative_pnl   DECIMAL(20,2)  NOT NULL DEFAULT 0,
  trades_opened    INT            NOT NULL DEFAULT 0,
  trades_closed    INT            NOT NULL DEFAULT 0,
  waves_detected   INT            NOT NULL DEFAULT 0,
  win_rate         DECIMAL(5,2)   NULL,
  created_at       TIMESTAMP      NOT NULL DEFAULT CURRENT_TIMESTAMP,

  UNIQUE KEY uq_snapshot_mode_date (mode, date),
  INDEX idx_snapshots_date (date),
  INDEX idx_snapshots_mode (mode)

) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

# Backtest module

Replay del detector de Wolfe Waves sobre histórico OHLCV de CoinEx para medir
performance y optimizar parámetros sin tocar producción.

## Estructura

```
src/backtest/
  types.ts         Tipos del simulador y resultado (BacktestConfig, SimTrade, etc.)
  dataLoader.ts    Descarga + cache local de histórico de CoinEx
  filters.ts       Filtros nuevos (volumen, EMA50, shape) — alineados al PDF Alba
  simulator.ts     Ciclo de vida del trade (entry, SL/TP, parciales, fees)
  replay.ts        Motor candle-by-candle sin look-ahead
  metrics.ts       KPIs (Sortino, Sharpe, Calmar, expectancy, etc.)
  report.ts        Reporte MD + CSV por corrida
  runner.ts        Orquestación: carga → replay → métricas
  cli.ts           Entrypoint CLI
  index.ts         Public API del módulo
```

Cache de datos: `backtest/data/<SYMBOL>_<TF>.json`
Reportes:        `backtest/reports/<runId>/{report.md,trades.csv,equity_curve.csv}`

Ambas carpetas están fuera de `src/` y deberían incluirse en `.gitignore`.

## Uso rápido

Benchmark del detector actual (sin filtros nuevos, sólo lo que ya hace el bot):

```bash
tsx src/backtest/cli.ts --symbol BTCUSDT --timeframe 1hour
```

Con filtros nuevos del PDF de Alba activados:

```bash
tsx src/backtest/cli.ts --symbol BTCUSDT --timeframe 1hour \
  --vol-min 1.1 --vol-exit 1.2 --ema-deadline 5 --shape-min 12 \
  --run-id alba_filters_v1
```

Sólo período específico:

```bash
tsx src/backtest/cli.ts --symbol ETHUSDT --timeframe 4hour \
  --from 2024-01-01 --to 2025-12-31
```

Flags disponibles: ver comentario en `cli.ts`.

## Reglas del replay (no look-ahead)

1. En cada paso `i`, se pasa al detector el slice `candles[0..i+1]`.
2. `findPivots` requiere `pivotStrength` velas a cada lado para confirmar un
   pivot, así que un pivot en `i` solo aparece en el array de pivots cuando
   `i + pivotStrength` ya fue procesado. El delay es automático.
3. La entrada se ejecuta al **open de la vela `i + 1`** (refleja producción:
   el scanner corre tras el cierre).
4. Si SL y TP caen en la misma vela: `ambiguousCandleSlFirst` decide (default
   `true` = SL primero, pesimista).

## Costos modelados

| Costo | Default | Configurable vía |
|---|---|---|
| Fee taker por lado | 0.2% | `--fee` |
| Slippage en market | 0.05% | `--slippage` |
| Spread efectivo | 0.05% (major) | `--spread` |

Cada partial close paga fee + spread independiente. El reporte muestra
`grossPnl` (sin fees) y `netPnl` (con fees) por trade.

## Filtros disponibles

Todos están **off por default**. Habilitarlos uno a uno permite A/B testing
contra el benchmark del detector actual.

| Filtro | Flag CLI | Referencia PDF |
|---|---|---|
| Volumen mínimo en P5 | `--vol-min` | §13 |
| Volumen exit post-P5 | `--vol-exit` | §13 |
| Deadline EMA50 break | `--ema-deadline` | §3.c, §11 |
| Score mínimo de shape | `--shape-min` | §9 |
| RR mínimo sobre TP2 | `--rr-min` | método estándar |
| SL por cierre (no mecha) | `--close-sl` | §3 ("sin superar P5") |

## Métricas reportadas

Cada corrida genera:

1. **`report.md`** — tabla de KPIs, breakdown por forma de onda, razones de
   cierre, PnL mensual, histograma de R-multiples.
2. **`trades.csv`** — ledger completo (1 fila por trade) con features para
   análisis externo en Excel/Pandas.
3. **`equity_curve.csv`** — curva de equity para graficar fuera.

KPIs incluidos: Total Return, CAGR, Max Drawdown, Sharpe, Sortino, Calmar,
Profit Factor, Win Rate, Expectancy en R y USD, Avg Win/Loss R, Avg RR
realizado, trades/mes, velas en trade promedio.

## Próximos pasos (no implementados aún)

- **Re-entrada en pullback** (§3.b PDF) — flag `--reentry`.
- **Doble Wolfe** (§5) — detection cross-wave.
- **Multi-TF confluence** (§12) — requiere cargar TF superior.
- **Onda bebé contraria** (§10.b) — requiere cargar TF inferior.
- **Walk-forward** — script aparte que itera IS/OOS.
- **Monte Carlo / Bootstrap** — robustness scripts.

Ver `wolfe wave/MEJORAS_BULLISH_Y_BACKTESTING.md` para el roadmap completo.

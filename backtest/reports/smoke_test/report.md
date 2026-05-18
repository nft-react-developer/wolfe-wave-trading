# Backtest Report — SYNTH_BULLISH 1hour

Periodo: 2025-01-01 → 2025-01-14
Velas analizadas: 336
Solo bullish: true

## Resultado

| Métrica | Valor |
|---|---|
| Capital inicial | $10000.00 |
| Capital final | $10020.51 |
| Retorno total | 0.21% |
| CAGR | 5.50% |
| Max Drawdown | 0.00% ($0.00) |
| Sharpe (anual) | 2462.48 |
| Sortino (anual) | 0.00 |
| Calmar | 0.00 |
| Profit Factor | ∞ |
| Win Rate | 100.00% |
| Expectancy (R) | 1.738 |
| Expectancy ($) | $6.84 |
| Avg Win (R) | 1.738 |
| Avg Loss (R) | 0.000 |
| Avg RR realizado | 0.00 |
| Trades totales | 3 |
| Trades cerrados | 3 |
| Trades/mes | 6.5 |
| Velas en trade (prom) | 13.7 |
| Wolfes detectadas | 85 |
| Wolfes filtradas | 82 |

## Configuración

```json
{
  "symbol": "SYNTH_BULLISH",
  "timeframe": "1hour",
  "initialCapital": 10000,
  "riskPerTradePct": 0.01,
  "maxTradeUsd": 200,
  "minOrderUsd": 30,
  "feePctPerSide": 0.002,
  "slippagePct": 0.0005,
  "spreadPct": 0.0005,
  "ambiguousCandleSlFirst": true,
  "entryMode": "market_at_p5",
  "entryConfirmWindowCandles": 3,
  "onlyBullish": true,
  "warmupCandles": 60,
  "filters": {
    "volumeWindow": 20,
    "reentryEnabled": false,
    "useCloseBasedSL": false
  }
}
```

## Por forma de la onda

| Shape | Trades | Win Rate | Avg R | Total PnL |
|---|---|---|---|---|
| long_neck | 3 | 100.00% | 1.738 | $20.51 |

## Razones de cierre

| Razón | Trades |
|---|---|
| tp2 | 3 |

## PnL mensual

| Mes | Trades | PnL |
|---|---|---|
| 2025-01 | 3 | $20.51 |

## Distribución de R-multiples

```
[   -3 → -2   ]    0 
[   -2 → -1   ]    0 
[   -1 → -0.5 ]    0 
[ -0.5 → 0    ]    0 
[    0 → 0.5  ]    0 
[  0.5 → 1    ]    0 
[    1 → 2    ]    3 ██████████████████████████████
[    2 → 3    ]    0 
[    3 → 5    ]    0 
[    5 → 10   ]    0 
```

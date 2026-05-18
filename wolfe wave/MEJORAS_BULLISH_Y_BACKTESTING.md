# Mejoras de Estrategia (Bullish) + Plan de Backtesting

> Análisis cruzado entre el código actual (`src/strategies/wolfeDetector.ts`,
> `src/services/scanner.ts`, `src/services/tradeManager.ts`, `src/utils/indicators.ts`)
> y la metodología original de **Alba Puerro** — *Onda de Wolfe. Formación sobre
> la figura y su operativa* (Madrid, 11/11/2015, 48 páginas).
> Foco: **ondas bullish** (figura M, entrada long en P5).
> Cada filtro propuesto cita la sección del PDF que lo justifica.

---

## 1. Reglas de Alba Puerro vs lo que ya hace el código

### Lo que el código YA cumple bien

| Regla de Alba (sección PDF) | Estado en el código |
|---|---|
| 5 puntos: P2>P1, P3<P2, P4>P3, P5<P3, P5 más bajo de todos (§1) | ✅ `validateBullish()` |
| Wolfe "perfecto" = canal 1-2 con línea 3-4 dentro (§1) | ✅ `isInsideChannel()` |
| P4 "preferiblemente un poco más alto que P1" (§1) | ✅ `isPerfect = p4.price >= p1.price` |
| Entrada **inmediata** al detectar (no esperar línea 1-3) (§3.a) | ✅ entrada en `p5.price` |
| SL un poco por debajo de P5 con margen (§3.a) | ✅ `slBuffer` con piso por TF |
| TP1 = 23.6% Fibo línea 2-3, TP2 = 61.8% (§4) | ✅ `target1=fib236`, `target2=fib618` |
| Cierre 50% en TP1, mover SL a BE (§4) | ✅ `evaluateTrade()` mueve SL a `entry` tras TP1 |
| Gordas M/W con TP3=100%, TP4=161.8% (§6) | ✅ `fat_mw` con `target3/target4` |
| EMA50 como guía (§3.c) | ✅ `emaPeriod=50` por default |
| MACD (9, 18, 9) para divergencias (§3.c y §11) | ✅ defaults idénticos |

### Lo que FALTA o está incompleto

| Regla de Alba | Sección PDF | Estado | Impacto bullish |
|---|---|---|---|
| **Volumen ascendente hasta P5, pico en zona P5** | §13 (Anexo Volumen) | ❌ Ignorado | Alto: filtra wolfes flojas |
| **Volumen POST-P5 < volumen P5 = wolfe sigue viva; si POST > P5 = wolfe fallando** | §13 | ❌ No detección | Muy alto: salida temprana evita SL |
| **EMA50 — el precio debe vencerla tras P5** | §3.c, §11 | ❌ Solo se loguea | Alto: filtra ondas que no rompen resistencia |
| **MACD divergencia en P5 = "apoyo de entrada"** | §3.c, §11 | ⚠️ Se calcula pero no usa | Medio: es bonus, no obligatorio |
| **Segunda oportunidad: re-entrada en pullback a P5** | §3.b | ❌ No implementado | Alto: doblar tras SL si vuelve a P5 |
| **Línea 1-4 como TP intermedio si cae entre 23.6% y 61.8%** | §4 | ❌ Ignorada | Medio: TP extra real, no especulativo |
| **Doble Wolfe (encadenadas): consecución TP1 ≈ 85%** | §5 | ❌ `isDoubleWolfe: false` hardcoded | Alto: boost de probabilidad |
| **Ondas reconfirmadas (misma onda en 2 TFs)** | §12 | ❌ No detección | Medio: boost si confirma |
| **Onda bebé contraria en TF menor → la bebé se cumple primero** | §10.b | ❌ Sin detección | Medio: timing de entrada |
| **Cuello largo cuerpo pequeño: 50% éxito vs Gorda M/W: 75-85%** | §9 | ⚠️ Clasifica pero todos pesan igual | Alto: filtrar/desweightear cuello largo |

### Mitos que el PDF DESMIENTE (y mis recomendaciones previas tenían que ajustarse)

1. **"Filtrar wolfes contra-tendencia"** — ❌ NO. §7 muestra:
   - Con tendencia: **70% éxito**
   - Contra tendencia: **80% éxito** *(las wolfes contra-tendencia son las MÁS rentables)*

   El wolfe ES por definición un patrón de reversión (§3 entero). Mi sugerencia previa de filtrar por sesgo HTF bajista en bullish estaba MAL. Lo correcto es **exigir más confirmación** (volumen + EMA50 break + MACD divergence) pero no filtrar.

2. **"MACD divergencia obligatoria"** — ⚠️ Matiz. Alba la pone como **apoyo de entrada**, no como filtro duro. Va al sistema de scoring, no a un reject.

3. **"Lo más importante: ojos en el VOLUMEN"** — Lo enfaticé poco en el primer informe. Para Alba es la **clave para detectar wolfes fallidas en tiempo real** (§13). Esto va a la cabeza de la lista de prioridades.

---

## 2. Plan de mejoras alineado al PDF — orden de prioridad

### Prioridad 1 — Volumen (§13)

**1.1. Volumen mínimo en P5**

> *"Para que se forme una onda fiable debemos tener un volumen algo más alto
> del normal (y un mínimo de volumen exigido) en la zona del punto 5"* — §13

```ts
// en buildWave(), tras validar la geometría
const volWindow = candles.slice(Math.max(0, p5.index - 20), p5.index);
const avgVol = mean(volWindow.map(c => c.volume));
const p5VolWindow = candles.slice(Math.max(0, p5.index - 2), p5.index + 1);
const maxP5Vol = Math.max(...p5VolWindow.map(c => c.volume));

const p5VolRatio = maxP5Vol / avgVol;     // ratio vs promedio 20 velas
const minVolRatio = config.minP5VolumeRatio ?? 1.1;
if (p5VolRatio < minVolRatio) return null;
```

Notas:
- "Zona del P5" = no exige que el pico sea exactamente en P5, sino "en la zona" → ventana de ±2 velas alrededor.
- Pico **ascendente hasta P5** se penaliza más suave (va al score).
- En cripto el volumen puede estar inflado por wash trading → ratio 1.1× es prudente al inicio, optimizable en backtest.

**1.2. Volumen post-P5 como señal de salida temprana**

> *"Si posteriormente el volumen que va saliendo es MENOR que el del punto 5,
> todo va bien... Si POSTERIORMENTE sale uno MAYOR, la onda se va a la baja
> (fallando)"* — §13

En `evaluateTrade()`, antes del check de SL:

```ts
// Post-P5 volume monitor (Alba §13)
const wave = await getWaveById(trade.wolfeWaveId);
const p5Vol = candles[wave.p5.index].volume;
const postCandles = candles.slice(wave.p5.index + 1);

const exitOnVolume =
  postCandles.length >= 2 &&
  postCandles.some(c => c.volume > p5Vol * 1.2);   // 20% buffer

if (exitOnVolume && trade.closedQty1 === 0) {
  // Cerrar early — evita ir a SL completo
  await this.closeTrade(trade.id, currentPrice, 'volume_exit', pnl);
  return;
}
```

Esto es probablemente **el cambio de mayor impacto en win-rate**. El SL pierde el 100% del riesgo de esa mitad de posición; una salida por volumen pierde típicamente 30-50%.

### Prioridad 2 — EMA50 (§3.c, §11)

**2.1. Filtro post-entrada de "el precio debe vencer la EMA50"**

> *"Una tendencia intradiaria muy fuerte, marcada, hará fallar con más facilidad
> nuestros wolfes... siempre observaremos su reacción en cuanto a la MM50"* — §8.c

> *"Es MUY IMPORTANTE que tras la divergencia pueda con la Media de 50"* — §11

Para **bullish**, tras la entrada en P5, el precio típicamente está **por debajo** de la EMA50 (porque viene de bajada — es contra-tendencia). Si en N velas no logra cruzarla:

```ts
// Filtro post-entrada — en evaluateTrade()
const candlesSinceEntry = (now - trade.entryTime) / candleDurationMs;
const ema50Now = latestEMA50(candles);

if (candlesSinceEntry >= 5 && currentPrice < ema50Now && trade.closedQty1 === 0) {
  // Precio no ha podido con la EMA50 → wolfe perdiendo fuerza
  // Cerrar parcial (50%) por seguridad, dejar el resto con SL ajustado
  await closeHalfPosition(trade, currentPrice);
}
```

Configurable: `EMA50_BREAK_DEADLINE_CANDLES=5`.

**2.2. EMA50 en P5 NO se usa como filtro de entrada**

Alba es explícita (§3.c): el wolfe te dice "largos cuando el precio está por
DEBAJO de la EMA50" — es esperado en bullish. **No filtrar entradas por EMA50.**
Solo se mide su quiebre POST-entrada.

### Prioridad 3 — MACD divergencia como score, no como filtro (§11)

> *"Si en ese movimiento hacia el punto 5, ya sea alcanzándolo o dilatándolo,
> tenemos divergencia acompañando el sentido de la Onda de Wolfe, es sin duda
> buen momento de reentrada"* — §3.c

> *"Podemos utilizar MACD (9-18-9), Momentum (28) o RSI (7) — si sale una
> divergencia en alguno de los tres, nos vale"* — §11.a

El código actual solo mira MACD. Sumar Momentum(28) y RSI(7) en paralelo:

```ts
const hasMacdDiv = hasMACDDivergence(...)
const hasMomDiv  = hasMomentumDivergence(candles, 28, 'bullish');
const hasRsiDiv  = hasRSIDivergence(candles, 7, 'bullish');

wave.divergenceScore =
  (hasMacdDiv ? 1 : 0) +
  (hasMomDiv  ? 1 : 0) +
  (hasRsiDiv  ? 1 : 0);
```

Score 0/1/2/3 — va al puntaje agregado, **no rechaza la onda**.

### Prioridad 4 — Re-entrada en pullback a P5 (§3.b)

> *"Cuando aparece una onda de wolfe, una parte del recorrido ya está completada,
> inmediatamente entramos y el precio gira en un pullback directo hacia nuestro
> Stop Loss: este es un movimiento normal... cuando el precio esté cerca del punto 5,
> abrir una nueva posición (otra, con SL un poco más separado del anterior)"* — §3.b

Implementación en `TradeService`:

```ts
// Tras un cierre por SL en una wave, abrir watcher por N velas
// Si el precio vuelve cerca de P5 (±0.3% por defecto), abrir 2da posición
//   - Nuevo SL más separado (factor 1.5×)
//   - Mismo TP1/TP2
//   - Marcar trade.reentryNumber = 2 (máx 2 reentradas por wave)
```

Configurables nuevos:
- `REENTRY_ENABLED=true`
- `REENTRY_MAX_PER_WAVE=1`            // default 1 (es decir, hasta 2 tries totales)
- `REENTRY_PROXIMITY_PCT=0.003`       // 0.3% del P5
- `REENTRY_SL_WIDEN_FACTOR=1.5`       // SL 1.5× más amplio que original
- `REENTRY_WINDOW_CANDLES=10`         // ventana de validez

Este es uno de los cambios que **más cambia las estadísticas** según el PDF.
Alba lo describe como "movimiento normal de la onda".

### Prioridad 5 — Salida temprana si vuelve a romper P5 (§3 — invalidación)

> *"Si un patrón indica caídas, indica que llegará a los objetivos en el corto
> plazo **sin volver a superar ya el punto 5**. Este es el punto más importante:
> sin volver a superar ya el punto 5"* — §3

El SL ya cumple esto en parte, pero con cierre por mecha. Mejor: cerrar al **cierre de vela** debajo de P5 + margen, no por mecha. Implementación:

```ts
const slHitByClose = isLong
  ? candle.close < p5.price - slBuffer
  : candle.close > p5.price + slBuffer;
```

Pequeño cambio: usar cierre de vela (no precio intra) para el SL ablandado del paper trading. Reduce stops por mechas barridas (sweep).

### Prioridad 6 — Línea 1-4 como TP intermedio (§4)

> *"El objetivo 2 lo deberemos señalar en el 61.8%, o si la línea 1-4 está en medio,
> marcaremos primero 23.6%, **línea 1-4** y 61.8%"* — §4

El código actual ya calcula `line14Price` pero solo lo guarda. Convertirlo en
TP1.5 cuando cae entre TP1 y TP2:

```ts
// En buildWave():
const line14Price = projectLine(p1.index, p1.price, p4.index, p4.price, p5.index + 1);

const tp15 =
  (direction === 'bullish' && line14Price > target1 && line14Price < target2) ||
  (direction === 'bearish' && line14Price < target1 && line14Price > target2)
    ? line14Price
    : undefined;

// Si existe, cerrar 25% en TP1, 25% en TP1.5, 50% en TP2
// (o cualquier distribución parametrizable)
```

### Prioridad 7 — Doble Wolfe (§5)

> *"En este caso, la consecución del Objetivo 1 de la última onda está
> prácticamente asegurada... probabilidad de éxito al 85%"* — §5

**Detección**: una onda Wolfe nueva donde sus puntos P1, P2, P3 coinciden
(±tolerancia) con P3, P4, P5 de una wolfe previa registrada en DB.

```ts
async function checkDoubleWolfe(wave: WolfeWave): Promise<boolean> {
  const candleDurationMs = timeframeToMs(wave.timeframe);
  const recentWaves = await getWavesNearTimestamp(
    wave.symbol, wave.timeframe, wave.direction,
    wave.p1.timestamp - candleDurationMs * 3,
    wave.p1.timestamp + candleDurationMs * 3
  );

  for (const prev of recentWaves) {
    const closeEnough = (a: number, b: number) => Math.abs(a - b) / b < 0.005;
    if (
      closeEnough(prev.p3.price, wave.p1.price) &&
      closeEnough(prev.p4.price, wave.p2.price) &&
      closeEnough(prev.p5.price, wave.p3.price)
    ) {
      return true;
    }
  }
  return false;
}
```

Si `isDoubleWolfe = true`: **subir score +20** y opcionalmente subir el position
sizing (1.5× del normal) porque la probabilidad pasa de ~75% a ~85%.

### Prioridad 8 — Forma de la onda como peso (§9)

Estadísticas del PDF:
- **Gorda M/W**: 75-85% éxito
- **Cuello largo cuerpo gordo**: ~60% éxito
- **Cuello largo cuerpo pequeño**: ~50% éxito
- **Perfecta**: 75% éxito
- **Imperfecta**: 52% éxito

Mapear directo al scoring:

```ts
const shapeScoreBase: Record<WolfeShape, number> = {
  fat_mw:    25,   // 80% promedio
  perfect:   22,   // 75%
  long_neck: 12,   // 55% (penalizado)
  imperfect: 15,   // 52% pero con menos certeza estadística
};
```

Y diferenciar dentro de `long_neck` por cuerpo (pequeño vs gordo):

```ts
function longNeckBodySize(p3: WP, p4: WP): 'small' | 'fat' {
  const bodyRange = Math.abs(p4.price - p3.price);
  const neckRange = Math.abs(p2.price - p1.price);
  return (bodyRange / neckRange) > 0.5 ? 'fat' : 'small';
}
```

Restar 5 más al score si es `long_neck` + `small`.

### Prioridad 9 — Confirmación multi-TF (§12)

> *"Las Ondas reconfirmadas... si la misma onda aparece en 2 TFs diferentes o
> hay otra Wolfe en TF inferior en la misma dirección"* — §12

Implementación:

```ts
async function checkMultiTimeframeConfirm(wave: WolfeWave): Promise<{
  sameWaveOnHTF: boolean;   // misma onda visible en TF superior
  alignedOnLTF:  boolean;   // otra wolfe alineada en TF inferior
}> { ... }
```

Si `sameWaveOnHTF` → score +15. Si `alignedOnLTF` → score +10.

### Prioridad 10 — Onda bebé contraria en TF inferior (§10.b)

> *"Si sale una Onda bebé al contrario, vuelve a cumplirse la norma de que se
> completará la pequeña, y cuando esta lo haga, el precio quedará libre para
> continuar el recorrido de la mayor"* — §10.b

Pre-entry filter:

```ts
async function hasOpposingBabyWolfe(wave: WolfeWave): Promise<boolean> {
  const ltf = lowerTimeframe(wave.timeframe);
  if (!ltf) return false;
  const oppositeDir = wave.direction === 'bullish' ? 'bearish' : 'bullish';
  return await waveActiveOn(wave.symbol, ltf, oppositeDir);
}
```

Si retorna `true`: **demorar entrada** N velas hasta que la bebé se cumpla
(o invalide). No rechazar — solo retrasar.

---

## 3. Sistema de scoring final (suma de Alba)

| Componente | Pts máx | Cita PDF |
|---|---|---|
| Forma de la onda (fat_mw/perfect/...) | 25 | §9 |
| Volumen P5 ratio ≥ 1.1 | 15 | §13 |
| Pico de volumen ascendente hasta P5 | 5 | §13 |
| Divergencia MACD bullish | 8 | §3.c, §11 |
| Divergencia Momentum/RSI | 4 (2+2) | §11.a |
| Doble Wolfe | 15 | §5 |
| Reconfirmada en HTF | 10 | §12 |
| Wolfe alineado en LTF | 5 | §12 |
| RR sobre TP2 ≥ 2 | 5 | método estándar |
| P5 con sweep de P3 (mecha < P3, close > P3) | 5 | inferido de §3 (margen) |
| Sin onda bebé contraria activa | 3 | §10.b |

**Total: 100**

Operar bullish solo con `score >= score_threshold` (parámetro a calibrar
por backtest). Sospecha previa: ~55-65 será el sweet spot.

---

## 4. Plan de Backtesting (versión final, alineada al PDF)

### 4.1. Datos
- Fuente: OHLCV de CoinEx (mismo feed que producción).
- Símbolos: scanner actual + top-30 por volumen + delisted históricos.
- TFs: 5min, 15min, 30min, 1hour, 4hour, 1day.
- Historial: 24+ meses.
- **Volumen incluido** (no opcional — §13 lo exige).
- Cache local: archivos JSON por `{symbol}_{tf}.json` en `backtest/data/`.

### 4.2. Replay engine — sin look-ahead

Regla crítica: un pivot solo se confirma `pivotStrength` velas después de
formarse. En el replay, una wolfe con P5 en `i` solo es **detectable** en
`i + pivotStrength + 1`. El detector actual ya respeta P5-último-pivot, pero
el replay debe ocultar futuras velas durante la detección.

### 4.3. Reglas de simulación (pesimistas por defecto)

| Evento | Regla |
|---|---|
| Entrada market | `candle[t+1].open × (1 + slippage)`, slippage 0.05% |
| Fees taker CoinEx | 0.2% por lado |
| Spread efectivo | 0.05% major, 0.15% altcoin |
| SL hit | `candle.low ≤ SL` → fill al SL exacto (pesimista) |
| TP hit | `candle.high ≥ TP` → fill al TP exacto |
| Ambigüedad SL+TP misma vela | SL primero (pesimista) |
| Cierre por volumen (§13) | en cuanto vol(t) > p5Vol × 1.2 |
| Cierre por EMA50 deadline | 5 velas sin cruzar EMA50 → cierre parcial |
| Re-entrada §3.b | watcher 10 velas tras SL si vuelve a ±0.3% de P5 |

### 4.4. Métricas

Por trade: `entry, exit, R, MFE, MAE, TIT, tp1Hit, tp2Hit, reentry, score,
shape, p5VolRatio, hasDivergence, brokeEMA50, volExit, candlesToTp1`.

Agregadas: `Total Return, CAGR, MaxDD, Calmar, Sortino, Sharpe, Profit Factor,
Expectancy (R), Win Rate, Avg Win R, Avg Loss R, Trades/mes`.

Por segmento: símbolo, TF, shape, régimen BTC, sesión, día semana.

### 4.5. Parámetros a optimizar (top-down)

| Parámetro | Rango | Default |
|---|---|---|
| `score_threshold` | 40, 50, 55, 60, 65, 70, 80 | — |
| `minP5VolumeRatio` | 0.8, 1.0, 1.1, 1.3, 1.5 | 1.1 |
| `volumeExitRatio` | 1.0, 1.1, 1.2, 1.5 | 1.2 |
| `ema50DeadlineCandles` | off, 3, 5, 8, 12 | 5 |
| `reentryEnabled` | true/false | true |
| `reentryProximityPct` | 0.002, 0.003, 0.005 | 0.003 |
| `pivotStrength` (por TF) | ±2 actual | — |
| `minRrRatio` | 1.5, 2.0, 2.5, 3.0 | 2 |
| `slBufferMode` | fixed_pct / atr / leg_pct | leg_pct |
| `entryMode` | market_at_p5 / confirm_candle / limit_at_p5 | market_at_p5 |
| `trailingMethod` | structure_low / atr / percentage | structure_low |

### 4.6. Walk-forward (obligatorio)

`[IS 12m | OOS 3m | IS+3m | OOS | ...]`. Reportar SOLO OOS. Re-optimizar cada
3 meses sobre la ventana IS. Objetivo: **Sortino**, no return puro.

### 4.7. Robustez

- Sensibilidad ±20% en cada parámetro.
- Monte Carlo (shuffle de orden 1000×) para distribución de MaxDD.
- Bootstrap 500× para CI 95% en win-rate y expectancy.
- Test por régimen BTC (alcista / lateral / bajista).

### 4.8. Anti-patterns

- Look-ahead bias (pivot confirmación).
- Survivorship bias (incluir delisted).
- In-sample fitting (siempre reportar OOS).
- Fills perfectos (usar slippage + spread).
- Optimización sobre return (overfit a outliers — usar Sortino).

---

## 5. TL;DR

1. **Volumen** es el filtro más infravalorado y el de mayor impacto esperado
   (Alba dedica el Anexo §13 entero a esto). El código actual lo ignora 100%.
2. **Re-entrada en pullback a P5** (§3.b) duplica oportunidades y es metodología
   nativa, no especulación.
3. **Salida temprana por volumen post-P5** (§13) sustituye SLs grandes por
   pérdidas pequeñas — probable mayor mejora en expectancy.
4. **Forma de la onda** ya se clasifica pero no se pondera — perder eso es
   tirar información de 75% vs 50% éxito por la borda.
5. **MACD divergencia obligatoria** estaba sobre-vendido en mi informe previo.
   Alba la trata como **bonus**, no como filtro duro. Va al scoring.
6. **Filtrar por sesgo HTF** estaba MAL: wolfes contra-tendencia tienen
   mejor win-rate (80% vs 70% según §7). Lo correcto es exigir más
   confirmación, no descartar.
7. **El backtest debe medir todo lo del PDF** desde día 1 (volumen, EMA50
   break, shape, doble wolfe, multi-TF), sino estás optimizando un subconjunto
   incompleto del método.

---

## 6. Roadmap de implementación

**Fase A — Backtest base** (lo que vamos a construir ahora):
1. `src/backtest/` con `dataLoader`, `replay`, `simulator`, `metrics`, `report`, `cli`.
2. Benchmark del detector actual sin cambios — 12 meses de datos.
3. Validar que las stats del benchmark son razonables (win-rate ~40-60%
   sobre cripto coincide aproximadamente con lo del PDF en forex).

**Fase B — Filtros nuevos detrás de flags**:
4. Volumen P5 + volumen exit.
5. EMA50 deadline.
6. Forma como score.
7. Re-entrada en pullback.
8. Línea 1-4 como TP intermedio.

**Fase C — Optimización**:
9. Walk-forward sobre top-6 parámetros.
10. Robustez.
11. Selección de set ganador → paper trading 30 días → real con tamaño reducido.

**Fase D — Avanzado** (después de que A-C estén estables):
12. Doble Wolfe detection.
13. Multi-TF confluence.
14. Bebé contraria filter.
15. Scoring 0-100 completo.

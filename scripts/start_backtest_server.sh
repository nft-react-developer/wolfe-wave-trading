#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# start_backtest_server.sh — Arranca el batchRunner en segundo plano
#
# Uso:
#   chmod +x scripts/start_backtest_server.sh
#   ./scripts/start_backtest_server.sh            # arrancar
#   ./scripts/start_backtest_server.sh stop       # detener
#   ./scripts/start_backtest_server.sh status     # ver si está corriendo
#   ./scripts/start_backtest_server.sh logs       # tail del log en tiempo real
#
# Variables de entorno opcionales (se pueden setear antes de llamar al script):
#   BACKTEST_TIMEFRAMES=15min,30min   (default)
#   BACKTEST_INTERVAL_H=6             horas entre rondas (default 6)
#   BACKTEST_ONLY_BULLISH=true        (default)
#   BACKTEST_ENTRY_MODE=market_at_p5  (default)
#
# Ejemplo con config custom:
#   BACKTEST_INTERVAL_H=4 BACKTEST_ONLY_BULLISH=false ./scripts/start_backtest_server.sh
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

# ── Rutas ─────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
PID_FILE="${ROOT_DIR}/backtest/backtest_server.pid"
LOG_FILE="${ROOT_DIR}/backtest/backtest_server.log"

# ── Comando ───────────────────────────────────────────────────────────────────
CMD="npx tsx src/backtest/batchRunner.ts"

# ─────────────────────────────────────────────────────────────────────────────

start() {
  if [[ -f "$PID_FILE" ]]; then
    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
      echo "⚠️  El backtest server ya está corriendo (PID $PID)."
      echo "   Usá './scripts/start_backtest_server.sh stop' para detenerlo primero."
      exit 1
    else
      echo "PID file encontrado pero el proceso no existe — limpiando."
      rm -f "$PID_FILE"
    fi
  fi

  cd "$ROOT_DIR"

  # Crear directorio de backtest si no existe
  mkdir -p backtest/data backtest/reports

  echo "🚀 Arrancando backtest server…"
  echo "   Log: $LOG_FILE"
  echo "   PID: $PID_FILE"
  echo ""
  echo "   Timeframes : ${BACKTEST_TIMEFRAMES:-15min,30min}"
  echo "   Símbolos   : ${BACKTEST_SYMBOLS:-$(grep '^SCAN_SYMBOLS=' .env 2>/dev/null | cut -d= -f2 || echo 'BTCUSDT,ETHUSDT,SOLUSDT')}"
  echo "   Intervalo  : ${BACKTEST_INTERVAL_H:-6}h"
  echo ""

  # Lanzar en background con nohup
  nohup $CMD >> "$LOG_FILE" 2>&1 &
  PID=$!
  echo "$PID" > "$PID_FILE"

  sleep 1
  if kill -0 "$PID" 2>/dev/null; then
    echo "✅ Backtest server arrancado (PID $PID)"
    echo "   ./scripts/start_backtest_server.sh logs   → seguir el log"
    echo "   ./scripts/start_backtest_server.sh stop   → detener"
  else
    echo "❌ El proceso falló al arrancar. Revisá el log:"
    tail -20 "$LOG_FILE"
    exit 1
  fi
}

stop() {
  if [[ ! -f "$PID_FILE" ]]; then
    echo "No hay PID file — el servidor no parece estar corriendo."
    exit 0
  fi

  PID=$(cat "$PID_FILE")

  if kill -0 "$PID" 2>/dev/null; then
    echo "🛑 Deteniendo backtest server (PID $PID)…"
    kill -TERM "$PID"
    # Esperar hasta 10s a que termine limpiamente
    for i in {1..10}; do
      sleep 1
      if ! kill -0 "$PID" 2>/dev/null; then
        echo "✅ Servidor detenido."
        rm -f "$PID_FILE"
        exit 0
      fi
    done
    echo "⚠️  No terminó a tiempo — forzando con SIGKILL."
    kill -KILL "$PID" 2>/dev/null || true
    rm -f "$PID_FILE"
    echo "Servidor forzado a terminar."
  else
    echo "El proceso $PID ya no existe. Limpiando PID file."
    rm -f "$PID_FILE"
  fi
}

status() {
  if [[ ! -f "$PID_FILE" ]]; then
    echo "🔴 Backtest server: NO corriendo"
    exit 0
  fi

  PID=$(cat "$PID_FILE")
  if kill -0 "$PID" 2>/dev/null; then
    echo "🟢 Backtest server: CORRIENDO (PID $PID)"
    echo "   Log: $LOG_FILE"
    echo "   Últimas líneas:"
    tail -5 "$LOG_FILE" 2>/dev/null | sed 's/^/   /'
  else
    echo "🔴 Backtest server: NO corriendo (PID file obsoleto)"
    rm -f "$PID_FILE"
  fi
}

logs() {
  echo "📋 Siguiendo $LOG_FILE (Ctrl+C para salir)…"
  echo ""
  tail -f "$LOG_FILE"
}

# ─── Dispatch ─────────────────────────────────────────────────────────────────

ACTION="${1:-start}"

case "$ACTION" in
  start)  start  ;;
  stop)   stop   ;;
  status) status ;;
  logs)   logs   ;;
  restart)
    stop || true
    sleep 2
    start
    ;;
  *)
    echo "Uso: $0 {start|stop|status|logs|restart}"
    exit 1
    ;;
esac

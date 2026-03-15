import WebSocket from 'ws';
import type { IExchange, IPriceFeed } from '../types';
import { logger } from '../utils/logger';

// ─── Polling Price Feed ───────────────────────────────────────────────────────
//
// Prices come from the scanner's candle cycle. This implementation does nothing
// on its own — the Scanner calls onPrice manually after fetching candles.
// It exists only so the Scanner can treat both modes uniformly.

export class PollingPriceFeed implements IPriceFeed {
  private callback: ((symbol: string, price: number) => void) | null = null;

  start(_symbols: string[], onPrice: (symbol: string, price: number) => void): void {
    this.callback = onPrice;
    logger.info('PriceFeed: polling mode (prices from candle scan cycle)');
  }

  stop(): void {
    this.callback = null;
  }

  /** Called by the Scanner after each candle fetch to deliver the latest price. */
  push(symbol: string, price: number): void {
    this.callback?.(symbol, price);
  }
}

// ─── WebSocket Price Feed ─────────────────────────────────────────────────────
//
// Subscribes to CoinEx spot ticker over WebSocket and calls onPrice on every
// update. The Scanner's checkOpenTrades is triggered immediately on each tick
// instead of waiting for the next polling cycle.
//
// CoinEx WS base: wss://socket.coinex.com/v2/spot
// Subscription method: "state.subscribe" with the list of markets
// Ticker push method:  "state.update"
//
// ref: https://docs.coinex.com/api/v2/spot/market/ws/market-status

const WS_URL = 'wss://socket.coinex.com/v2/spot';

// How long to wait before reconnecting after a disconnect (ms)
const RECONNECT_DELAY_MS = 5_000;

// CoinEx WS requires a ping every 30s or the server closes the connection
const HEARTBEAT_INTERVAL_MS = 25_000;

export class WebSocketPriceFeed implements IPriceFeed {
  private ws:        WebSocket | null = null;
  private symbols:   string[]  = [];
  private callback:  ((symbol: string, price: number) => void) | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  start(symbols: string[], onPrice: (symbol: string, price: number) => void): void {
    this.symbols  = symbols;
    this.callback = onPrice;
    this.stopped  = false;
    this.connect();
    logger.info('PriceFeed: websocket mode', { symbols });
  }

  stop(): void {
    this.stopped = true;
    this.clearHeartbeat();
    this.clearReconnectTimer();
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    logger.info('PriceFeed: websocket stopped');
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private connect(): void {
    if (this.stopped) return;

    logger.debug('PriceFeed: connecting to CoinEx WebSocket...');

    this.ws = new WebSocket(WS_URL);

    this.ws.on('open', () => {
      logger.info('PriceFeed: WebSocket connected');
      this.subscribe();
      this.startHeartbeat();
    });

    this.ws.on('message', (data: WebSocket.RawData) => {
      try {
        this.handleMessage(JSON.parse(data.toString()));
      } catch {
        // ignore malformed frames
      }
    });

    this.ws.on('error', (err: any) => {
      logger.error('PriceFeed: WebSocket error', err);
    });

    this.ws.on('close', (code, reason) => {
      logger.warn('PriceFeed: WebSocket closed', { code, reason: reason.toString() });
      this.clearHeartbeat();
      if (!this.stopped) this.scheduleReconnect();
    });
  }

  private subscribe(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    // CoinEx v2 WS: subscribe to state (ticker) for each symbol
    // method: "state.subscribe", params: [market1, market2, ...]
    const msg = JSON.stringify({
      method: 'state.subscribe',
      params: this.symbols,
      id:     1,
    });

    this.ws.send(msg);
    logger.debug('PriceFeed: subscribed to tickers', { symbols: this.symbols });
  }

  private handleMessage(msg: Record<string, unknown>): void {
    // ── Ticker push ──────────────────────────────────────────────────────────
    // { method: "state.update", params: [{ "BTCUSDT": { last: "84000.00", ... } }] }
    if (msg.method === 'state.update') {
      const params = msg.params as Array<Record<string, { last?: string }>>;
      if (!Array.isArray(params) || params.length === 0) return;

      const marketMap = params[0];
      for (const symbol of this.symbols) {
        const ticker = marketMap[symbol];
        if (!ticker?.last) continue;

        const price = Number(ticker.last);
        if (isNaN(price) || price <= 0) continue;

        this.callback?.(symbol, price);
      }
      return;
    }

    // ── Pong ─────────────────────────────────────────────────────────────────
    if (msg.method === 'server.pong' || (msg.id === 999 && msg.error === null)) {
      logger.debug('PriceFeed: pong received');
    }
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeat = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ method: 'server.ping', params: [], id: 999 }));
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private clearHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    logger.info(`PriceFeed: reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`);
    this.reconnectTimer = setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}
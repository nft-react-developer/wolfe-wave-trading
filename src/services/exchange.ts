import axios, { type AxiosInstance } from 'axios';
import crypto from 'crypto';
import type { Candle, ExchangeOrder, IExchange } from '../types';
import { logger } from '../utils/logger';

// ─── CoinEx V2 kline period values ───────────────────────────────────────────
// https://docs.coinex.com/api/v2/spot/market/http/list-market-kline

const TIMEFRAME_MAP: Record<string, string> = {
  '1min':  '1min',
  '3min':  '3min',
  '5min':  '5min',
  '15min': '15min',
  '30min': '30min',
  '1hour': '1hour',
  '2hour': '2hour',
  '4hour': '4hour',
  '6hour': '6hour',
  '12hour':'12hour',
  '1day':  '1day',
  '3day':  '3day',
  '1week': '1week',
};

// ─── CoinEx V2 REST client ────────────────────────────────────────────────────

export class CoinExExchange implements IExchange {
  private readonly client: AxiosInstance;
  private readonly accessId: string;
  private readonly secretKey: string;

  constructor() {
    this.accessId  = process.env.COINEX_ACCESS_ID  ?? '';
    this.secretKey = process.env.COINEX_SECRET_KEY ?? '';

    this.client = axios.create({
      baseURL: 'https://api.coinex.com/v2',
      timeout: 10_000,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  getName(): string { return 'CoinEx'; }

  // ─── Signature (CoinEx API v2) ───────────────────────────────────────────
  //
  // prepared_str = METHOD + request_path_with_querystring + body? + timestamp
  //   - body is included only for POST/PUT/DELETE (omitted for GET)
  //   - request_path starts with /v2/...
  //   - timestamp = X-COINEX-TIMESTAMP (unix ms as string)
  //
  // signed_str = HMAC-SHA256(prepared_str, secret_key)
  //   encoded with latin-1 (byte-for-byte), output lowercase hex
  //
  // ref: https://docs.coinex.com/api/v2/authorization

  private sign(method: string, requestPath: string, body: string, timestamp: string): string {
    // requestPath must include query string if present, e.g. /v2/spot/order?market=BTCUSDT&...
    const prepared = method.toUpperCase() + requestPath + body + timestamp;
    return crypto
      .createHmac('sha256', Buffer.from(this.secretKey, 'latin1'))
      .update(Buffer.from(prepared, 'latin1'))
      .digest('hex')
      .toLowerCase();
  }

  private authHeaders(method: string, requestPath: string, body = ''): Record<string, string> {
    const timestamp = String(Date.now());
    const sign = this.sign(method, requestPath, body, timestamp);
    return {
      'X-COINEX-KEY':       this.accessId,
      'X-COINEX-SIGN':      sign,
      'X-COINEX-TIMESTAMP': timestamp,
    };
  }

  // ─── Public: Kline / Candles ─────────────────────────────────────────────
  //
  // GET /spot/kline?market=BTCUSDT&period=1hour&limit=200
  //
  // Response data item:
  //   { market, created_at (ms), open, close, high, low, volume, value }
  //
  // ref: https://docs.coinex.com/api/v2/spot/market/http/list-market-kline

  async getCandles(symbol: string, timeframe: string, limit = 200): Promise<Candle[]> {
    const period = TIMEFRAME_MAP[timeframe] ?? timeframe;
    const queryString = `market=${symbol}&period=${period}&limit=${limit}`;
    const requestPath = `/v2/spot/kline?${queryString}`;

    try {
      const resp = await this.client.get('/spot/kline', {
        params: { market: symbol, period, limit },
      });

      const raw: Array<{
        created_at: number;
        open: string;
        close: string;
        high: string;
        low: string;
        volume: string;
      }> = resp.data?.data ?? [];

      return raw.map((k) => ({
        timestamp: k.created_at,          // already in ms
        open:      Number(k.open),
        high:      Number(k.high),
        low:       Number(k.low),
        close:     Number(k.close),
        volume:    Number(k.volume),
      }));
    } catch (err) {
      logger.error(`CoinEx getCandles error [${symbol}/${timeframe}]`, err);
      return [];
    }
  }

  // ─── Authenticated: Place order ──────────────────────────────────────────
  //
  // POST /spot/order
  // Body: { market, market_type, side, type, amount, price? }
  //   - amount and price must be strings
  //   - market_type: "SPOT" for spot trading
  //
  // Response data: { order_id, market, side, type, amount, price,
  //                  filled_amount, unfilled_amount, ... }
  //
  // ref: https://docs.coinex.com/api/v2/spot/order/http/put-order

  async placeOrder(params: {
    symbol:    string;
    side:      'buy' | 'sell';
    type:      'market' | 'limit';
    quantity:  number;
    price?:    number;
  }): Promise<ExchangeOrder> {
    const requestPath = '/v2/spot/order';

    const bodyObj: Record<string, unknown> = {
      market:      params.symbol,
      market_type: 'SPOT',
      side:        params.side,
      type:        params.type,
      amount:      params.quantity.toFixed(8),
    };
    if (params.type === 'limit' && params.price !== undefined) {
      bodyObj.price = params.price.toFixed(8);
    }

    const bodyStr = JSON.stringify(bodyObj);

    const resp = await this.client.post('/spot/order', bodyStr, {
      headers: this.authHeaders('POST', requestPath, bodyStr),
    });

    this.assertOk(resp.data, 'placeOrder');

    const d = resp.data.data;
    return {
      orderId:     String(d.order_id),
      symbol:      params.symbol,
      side:        params.side,
      price:       Number(d.price ?? 0),
      quantity:    Number(d.amount),
      status:      this.mapOrderStatus(d),
      filledPrice: Number(d.filled_amount) > 0
        ? Number(d.filled_value) / Number(d.filled_amount)
        : undefined,
    };
  }

  // ─── Authenticated: Cancel order ─────────────────────────────────────────
  //
  // POST /spot/cancel-order   ← NOT DELETE (changed in v2)
  // Body: { market, market_type, order_id (int) }
  //
  // ref: https://docs.coinex.com/api/v2/spot/order/http/cancel-order

  async cancelOrder(symbol: string, orderId: string): Promise<void> {
    const requestPath = '/v2/spot/cancel-order';
    const bodyStr = JSON.stringify({
      market:      symbol,
      market_type: 'SPOT',
      order_id:    Number(orderId),   // must be int, not string
    });

    const resp = await this.client.post('/spot/cancel-order', bodyStr, {
      headers: this.authHeaders('POST', requestPath, bodyStr),
    });

    this.assertOk(resp.data, 'cancelOrder');
  }

  // ─── Authenticated: Get order status ────────────────────────────────────
  //
  // GET /spot/order?market=BTCUSDT&market_type=SPOT&order_id=13400
  //   - query string is included in the signed path
  //
  // Response data order status values: "open" | "part_deal" | "done" | "cancel"
  //
  // ref: https://docs.coinex.com/api/v2/spot/order/http/get-order-status

  async getOrder(symbol: string, orderId: string): Promise<ExchangeOrder> {
    const qs          = `market=${symbol}&market_type=SPOT&order_id=${orderId}`;
    const requestPath = `/v2/spot/order?${qs}`;

    const resp = await this.client.get('/spot/order', {
      params:  { market: symbol, market_type: 'SPOT', order_id: Number(orderId) },
      headers: this.authHeaders('GET', requestPath),
    });

    this.assertOk(resp.data, 'getOrder');

    const d = resp.data.data;
    return {
      orderId:     String(d.order_id),
      symbol,
      side:        d.side,
      price:       Number(d.price ?? 0),
      quantity:    Number(d.amount),
      status:      this.mapOrderStatus(d),
      filledPrice: Number(d.filled_amount) > 0
        ? Number(d.filled_value) / Number(d.filled_amount)
        : undefined,
      filledAt:    d.updated_at ?? undefined,
    };
  }

  // ─── Authenticated: Get balances ─────────────────────────────────────────
  //
  // GET /assets/spot/balance   (no query params)
  //
  // Response data: [{ ccy, available, frozen }, ...]
  //
  // ref: https://docs.coinex.com/api/v2/assets/balance/http/get-spot-balance

  async getBalance(): Promise<Record<string, number>> {
    const requestPath = '/v2/assets/spot/balance';

    const resp = await this.client.get('/assets/spot/balance', {
      headers: this.authHeaders('GET', requestPath),
    });

    this.assertOk(resp.data, 'getBalance');

    const result: Record<string, number> = {};
    for (const item of resp.data.data ?? []) {
      result[item.ccy] = Number(item.available);
    }
    return result;
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  /** Map CoinEx v2 order status to internal ExchangeOrder status */
  private mapOrderStatus(d: { status?: string; unfilled_amount?: string; amount?: string }):
    'open' | 'filled' | 'cancelled' {
    if (d.status === 'done')   return 'filled';
    if (d.status === 'cancel') return 'cancelled';
    // 'open' or 'part_deal'
    return 'open';
  }

  /** Throw if CoinEx returns a non-zero code */
  private assertOk(responseData: { code?: number; message?: string }, context: string): void {
    if (responseData?.code !== 0) {
      throw new Error(
        `CoinEx API error in ${context}: code=${responseData?.code}, message=${responseData?.message}`
      );
    }
  }
}

// ─── Paper trading (simulates fills, uses real public candle data) ────────────

export class PaperExchange implements IExchange {
  private _balance: Record<string, number>;
  private orders   = new Map<string, ExchangeOrder>();
  private nextId   = 1;

  constructor(initialCapital: number) {
    this._balance = { USDT: initialCapital };
  }

  getName(): string { return 'Paper'; }

  /** Use the real public kline endpoint (no auth needed) */
  async getCandles(symbol: string, timeframe: string, limit = 200): Promise<Candle[]> {
    return new CoinExExchange().getCandles(symbol, timeframe, limit);
  }

  async placeOrder(params: {
    symbol:   string;
    side:     'buy' | 'sell';
    type:     'market' | 'limit';
    quantity: number;
    price?:   number;
  }): Promise<ExchangeOrder> {
    const id = String(this.nextId++);
    const isFilled = params.type === 'market';

    const order: ExchangeOrder = {
      orderId:     id,
      symbol:      params.symbol,
      side:        params.side,
      price:       params.price ?? 0,
      quantity:    params.quantity,
      status:      isFilled ? 'filled' : 'open',
      filledPrice: isFilled ? params.price : undefined,
      filledAt:    isFilled ? Date.now() : undefined,
    };

    this.orders.set(id, order);

    // Simulate balance update for market orders
    if (isFilled && params.price) {
      const usdValue = params.quantity * params.price;
      const base     = params.symbol.replace(/USDT$/, '');

      if (params.side === 'buy') {
        this._balance['USDT']  = (this._balance['USDT']  ?? 0) - usdValue;
        this._balance[base]    = (this._balance[base]    ?? 0) + params.quantity;
      } else {
        this._balance['USDT']  = (this._balance['USDT']  ?? 0) + usdValue;
        this._balance[base]    = Math.max(0, (this._balance[base] ?? 0) - params.quantity);
      }
    }

    return order;
  }

  async cancelOrder(_symbol: string, orderId: string): Promise<void> {
    const order = this.orders.get(orderId);
    if (order) order.status = 'cancelled';
  }

  async getOrder(_symbol: string, orderId: string): Promise<ExchangeOrder> {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`Paper order ${orderId} not found`);
    return order;
  }

  async getBalance(): Promise<Record<string, number>> {
    return { ...this._balance };
  }
}

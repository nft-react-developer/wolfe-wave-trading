import axios, { type AxiosInstance, type AxiosError } from 'axios';
import crypto from 'crypto';
import type { Candle, ExchangeOrder, IExchange } from '../types';
import { logger } from '../utils/logger';

// ─── CoinEx V2 kline period values ───────────────────────────────────────────

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

// ─── Helper: extract useful info from Axios errors ───────────────────────────

function formatAxiosError(err: unknown): object {
  if (axios.isAxiosError(err)) {
    const e = err as AxiosError;
    return {
      message:    e.message,
      status:     e.response?.status,
      statusText: e.response?.statusText,
      data:       e.response?.data,
      url:        e.config?.url,
      method:     e.config?.method,
    };
  }
  if (err instanceof Error) {
    return { message: err.message, stack: err.stack };
  }
  return { raw: String(err) };
}

// ─── CoinEx V2 REST client ────────────────────────────────────────────────────

export class CoinExExchange implements IExchange {
  private readonly client: AxiosInstance;
  private readonly accessId: string;
  private readonly secretKey: string;

  constructor() {
    this.accessId  = process.env.COINEX_ACCESS_ID  ?? '';
    this.secretKey = process.env.COINEX_SECRET_KEY ?? '';

    if (!this.accessId || !this.secretKey) {
      logger.warn('CoinEx credentials not set — authenticated endpoints will fail');
    }

    this.client = axios.create({
      baseURL: 'https://api.coinex.com/v2',
      timeout: 10_000,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  getName(): string { return 'CoinEx'; }

  // ─── Signature (CoinEx API v2) ───────────────────────────────────────────

  private sign(method: string, requestPath: string, body: string, timestamp: string): string {
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

  async getCandles(symbol: string, timeframe: string, limit = 200): Promise<Candle[]> {
    const period = TIMEFRAME_MAP[timeframe] ?? timeframe;

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
        timestamp: k.created_at,
        open:      Number(k.open),
        high:      Number(k.high),
        low:       Number(k.low),
        close:     Number(k.close),
        volume:    Number(k.volume),
      }));
    } catch (err) {
      logger.error(`CoinEx getCandles error [${symbol}/${timeframe}]`, formatAxiosError(err));
      return [];
    }
  }

  // ─── Authenticated: Place order ──────────────────────────────────────────

  async placeOrder(params: {
    symbol:    string;
    side:      'buy' | 'sell';
    type:      'market' | 'limit';
    quantity:  number;
    price?:    number;
  }): Promise<ExchangeOrder> {
    const requestPath = '/v2/spot/order';

    // Para market buy CoinEx espera el importe en USDT, no la cantidad base
    const isMarketBuy = params.type === 'market' && params.side === 'buy';
    const amount = isMarketBuy
      ? (params.quantity * (params.price ?? 0)).toFixed(2)  // USDT a gastar
      : params.quantity.toFixed(8);                          // cantidad base

    const bodyObj: Record<string, unknown> = {
      market:      params.symbol,
      market_type: 'SPOT',
      side:        params.side,
      type:        params.type,
      amount,
    };
    if (params.type === 'limit' && params.price !== undefined) {
      bodyObj.price = params.price.toFixed(8);
    }

    const bodyStr = JSON.stringify(bodyObj);

    logger.info('CoinEx placeOrder payload', {
      symbol:  params.symbol,
      side:    params.side,
      type:    params.type,
      amount,
      price:   params.price,
    });

    try {
      const resp = await this.client.post('/spot/order', bodyStr, {
        headers: this.authHeaders('POST', requestPath, bodyStr),
      });

      this.assertOk(resp.data, 'placeOrder');

      const d = resp.data.data;

      // Para market buy, d.amount es el importe USDT enviado, no las unidades base.
      // d.filled_amount contiene la cantidad base realmente ejecutada — la usamos
      // para que el SL posterior use la cantidad exacta disponible en el balance.
      const filledQty = Number(d.filled_amount) > 0
        ? Number(d.filled_amount)
        : Number(d.amount);

      return {
        orderId:     String(d.order_id),
        symbol:      params.symbol,
        side:        params.side,
        price:       Number(d.price ?? 0),
        quantity:    filledQty,
        status:      this.mapOrderStatus(d),
        filledPrice: Number(d.filled_amount) > 0
          ? Number(d.filled_value) / Number(d.filled_amount)
          : undefined,
      };
    } catch (err) {
      logger.error('CoinEx placeOrder error', formatAxiosError(err));
      throw err;
    }
  }

  // ─── Authenticated: Cancel order ─────────────────────────────────────────

  async cancelOrder(symbol: string, orderId: string): Promise<void> {
    const requestPath = '/v2/spot/cancel-order';
    const bodyStr = JSON.stringify({
      market:      symbol,
      market_type: 'SPOT',
      order_id:    Number(orderId),
    });

    try {
      const resp = await this.client.post('/spot/cancel-order', bodyStr, {
        headers: this.authHeaders('POST', requestPath, bodyStr),
      });
      this.assertOk(resp.data, 'cancelOrder');
    } catch (err) {
      logger.error('CoinEx cancelOrder error', formatAxiosError(err));
      throw err;
    }
  }

  // ─── Authenticated: Get order status ────────────────────────────────────

  async getOrder(symbol: string, orderId: string): Promise<ExchangeOrder> {
    const qs          = `market=${symbol}&market_type=SPOT&order_id=${orderId}`;
    const requestPath = `/v2/spot/order?${qs}`;

    try {
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
    } catch (err) {
      logger.error('CoinEx getOrder error', formatAxiosError(err));
      throw err;
    }
  }

  // ─── Authenticated: Get balances ─────────────────────────────────────────

  async getBalance(): Promise<Record<string, number>> {
    const requestPath = '/v2/assets/spot/balance';

    try {
      const resp = await this.client.get('/assets/spot/balance', {
        headers: this.authHeaders('GET', requestPath),
      });

      this.assertOk(resp.data, 'getBalance');

      const result: Record<string, number> = {};
      for (const item of resp.data.data ?? []) {
        result[item.ccy] = Number(item.available);
      }
      return result;
    } catch (err) {
      logger.error('CoinEx getBalance error', formatAxiosError(err));
      throw err;
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private mapOrderStatus(d: { status?: string; unfilled_amount?: string; amount?: string }):
    'open' | 'filled' | 'cancelled' {
    if (d.status === 'done')   return 'filled';
    if (d.status === 'cancel') return 'cancelled';
    return 'open';
  }

  private assertOk(responseData: { code?: number; message?: string }, context: string): void {
    if (responseData?.code !== 0) {
      throw new Error(
        `CoinEx API error in ${context}: code=${responseData?.code}, message=${responseData?.message}`
      );
    }
  }
}

// ─── Paper trading ────────────────────────────────────────────────────────────

export class PaperExchange implements IExchange {
  private _balance: Record<string, number>;
  private orders   = new Map<string, ExchangeOrder>();
  private nextId   = 1;

  constructor(initialCapital: number) {
    this._balance = { USDT: initialCapital };
  }

  getName(): string { return 'Paper'; }

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

    if (isFilled && params.price) {
      const usdValue = params.quantity * params.price;
      const base     = params.symbol.replace(/USDT$/, '');

      if (params.side === 'buy') {
        const available = this._balance['USDT'] ?? 0;
        if (usdValue > available) {
          throw new Error(
            `Paper balance insufficient: need $${usdValue.toFixed(2)}, have $${available.toFixed(2)} USDT`
          );
        }
        this._balance['USDT']  = available - usdValue;
        this._balance[base]    = (this._balance[base] ?? 0) + params.quantity;
      } else {
        const availableBase = this._balance[base] ?? 0;
        if (params.quantity > availableBase) {
          throw new Error(
            `Paper balance insufficient: need ${params.quantity} ${base}, have ${availableBase}`
          );
        }
        this._balance['USDT']  = (this._balance['USDT'] ?? 0) + usdValue;
        this._balance[base]    = availableBase - params.quantity;
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
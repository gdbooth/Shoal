import { fetch, readBody, BrokerError } from './http.js';

const BASE = {
  paper: process.env.ALPACA_PAPER_URL || 'https://paper-api.alpaca.markets',
  live:  process.env.ALPACA_LIVE_URL  || 'https://api.alpaca.markets',
};
const DATA_BASE = process.env.ALPACA_DATA_URL || 'https://data.alpaca.markets';

// One authenticated Alpaca session. Every method returns { status, body } and
// passes Alpaca's own JSON through — this is the shape the frontend expects.
class AlpacaSession {
  constructor({ keyId, secret, env }) {
    this.keyId = keyId;
    this.secret = secret;
    this.env = env;
    this.base = BASE[env];
    this.streamIntervalMs = 3000;
  }

  get headers() {
    return {
      'APCA-API-KEY-ID':     this.keyId,
      'APCA-API-SECRET-KEY': this.secret,
      'Content-Type':        'application/json',
    };
  }

  async req(path, { method = 'GET', body, base = this.base } = {}) {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: this.headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: await readBody(r) };
  }

  account()   { return this.req('/v2/account'); }
  positions() { return this.req('/v2/positions'); }

  orders(query) {
    const qs = new URLSearchParams({ status: 'all', limit: '100', ...query });
    return this.req(`/v2/orders?${qs}`);
  }

  placeOrder(order) { return this.req('/v2/orders', { method: 'POST', body: order }); }

  async closePosition(symbol) {
    const r = await this.req(`/v2/positions/${encodeURIComponent(symbol)}`, { method: 'DELETE' });
    if (r.status === 204) return { status: 200, body: { ok: true } };
    if (r.status === 404) return { status: 200, body: { ok: true, notFound: true } }; // no position, that's fine
    return r;
  }

  async cancelOrder(id) {
    const r = await this.req(`/v2/orders/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (r.status === 204) return { status: 200, body: { ok: true } };
    return r;
  }

  // ~3 years of daily bars per symbol. Alpaca's `limit` counts bars across all symbols in the request,
  // so ask for a start date and follow next_page_token until every page is in.
  async bars(symbols, days = 1100, { since } = {}) {
    const start = since || new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    const out = {};
    let token = null;
    for (let page = 0; page < 80; page++) {
      const qs = new URLSearchParams({
        symbols: symbols.join(','), timeframe: '1Day', start, limit: '10000', feed: 'iex', adjustment: 'split',
        ...(token ? { page_token: token } : {}),
      });
      const r = await this.req(`/v2/stocks/bars?${qs}`, { base: DATA_BASE });
      if (r.status !== 200) return r;
      for (const [sym, b] of Object.entries(r.body?.bars || {})) (out[sym] = out[sym] || []).push(...b);
      token = r.body?.next_page_token;
      if (!token) break;
    }
    return { status: 200, body: { bars: out } };
  }

  // Intraday bars for the intraday lab. IEX feed (free plan): extended hours included, the caller keeps
  // the regular session. ~190 bars per symbol per day at 5 minutes, so allow more pages than daily bars.
  async intradayBars(symbols, timeframe = '5Min', days = 60) {
    const start = new Date(Date.now() - days * 86_400_000).toISOString();
    const out = {};
    let token = null;
    for (let page = 0; page < 80; page++) {
      const qs = new URLSearchParams({
        symbols: symbols.join(','), timeframe, start, limit: '10000', feed: 'iex', adjustment: 'split',
        ...(token ? { page_token: token } : {}),
      });
      const r = await this.req(`/v2/stocks/bars?${qs}`, { base: DATA_BASE });
      if (r.status !== 200) return r;
      for (const [sym, b] of Object.entries(r.body?.bars || {})) (out[sym] = out[sym] || []).push(...b);
      token = r.body?.next_page_token;
      if (!token) break;
    }
    return { status: 200, body: { bars: out, timeframe } };
  }

  // Latest trade and today's / yesterday's daily bars per symbol (market-wide checks, e.g. SPY's day so far)
  stockSnapshots(symbols) {
    const qs = new URLSearchParams({ symbols: symbols.join(','), feed: 'iex' });
    return this.req(`/v2/stocks/snapshots?${qs}`, { base: DATA_BASE });
  }

  async snapshot() {
    const [account, positions, orders, clock] = await Promise.all([
      this.req('/v2/account'),
      this.req('/v2/positions'),
      this.req('/v2/orders?status=all&limit=50'),
      this.req('/v2/clock'),
    ]);
    return { account: account.body, positions: positions.body, orders: orders.body, clock: clock.body };
  }

  close() {}
}

export const alpaca = {
  id: 'alpaca',
  name: 'Alpaca Markets',
  endpoints: BASE,

  // Validate keys against /v2/account and return a live session.
  async connect({ keyId, secret, env }) {
    if (!keyId || !secret || !BASE[env]) {
      throw new BrokerError(400, 'Missing or invalid fields (keyId, secret, env)');
    }
    const session = new AlpacaSession({ keyId, secret, env });
    let r;
    try {
      r = await session.account();
    } catch (err) {
      throw new BrokerError(502, 'Could not reach Alpaca', err.message);
    }
    if (r.status !== 200) throw new BrokerError(401, 'Alpaca rejected these credentials', r.body);
    const a = r.body;
    return {
      session,
      account: {
        id:              a.id,
        status:          a.status,
        currency:        a.currency || 'USD',
        equity:          parseFloat(a.equity          || 0),
        buyingPower:     parseFloat(a.buying_power    || 0),
        cash:            parseFloat(a.cash            || 0),
        portfolioValue:  parseFloat(a.portfolio_value || 0),
        patternDayTrader: a.pattern_day_trader,
        tradingBlocked:   a.trading_blocked,
        daytradingBuyingPower: parseFloat(a.daytrading_buying_power || 0),
      },
    };
  },
};

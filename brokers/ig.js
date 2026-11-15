import fs from 'fs';
import path from 'path';
import { fetch, readBody, BrokerError, RateLimiter } from './http.js';

// IG REST API — spread betting only.
// The frontend speaks Alpaca's JSON shapes, so every method here translates
// IG's responses into those shapes (account, positions, orders, clock, bars).
//
// Rate limits are tight (roughly 30 non-trading requests per minute per
// account, plus a weekly allowance of historical price points), so:
//   - account + positions are cached for 15 s, however many tabs are streaming
//   - live prices come from Lightstreamer, not REST polling
//   - daily bars and ticker→epic lookups are cached on disk and topped up incrementally

const BASE = {
  paper: process.env.IG_DEMO_URL || 'https://demo-api.ig.com/gateway/deal',
  live:  process.env.IG_LIVE_URL || 'https://api.ig.com/gateway/deal',
};

// Vercel's filesystem is read-only apart from /tmp
const CACHE_DIR      = process.env.SHOAL_CACHE_DIR || (process.env.VERCEL ? '/tmp/shoal-cache' : path.resolve('.cache'));
const OVERRIDES_FILE = path.resolve('ig-epics.json');
const SNAPSHOT_TTL_MS = 15_000;
const MARKET_REFRESH_MS = 60_000;
const BARS_INITIAL = 220;   // 200-day breadth, 6-month momentum and 120-day ranks need ~200 bars; fetched once, then topped up
const BARS_KEEP = 252;
const EXPIRY = 'DFB';       // daily funded bet

// ── Disk cache (shared by all sessions; holds no credentials) ───────────────
function cachePath(name) { return path.join(CACHE_DIR, name); }
function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function saveJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
  } catch (err) {
    console.warn('[ig] cache write failed', file, err.message);
  }
}

const caches = {}; // env → { epics, bars }
function cacheFor(env) {
  if (!caches[env]) {
    caches[env] = {
      epics: loadJson(cachePath(`ig-epics-${env}.json`), {}),
      bars:  loadJson(cachePath(`ig-bars-${env}.json`), {}),
      inflight: new Map(),
    };
  }
  return caches[env];
}

// Optional ig-epics.json in the project root pins a ticker to a specific epic,
// e.g. { "AAPL": "UA.D.AAPL.DAILY.IP" }, or null to mark it untradeable.
function overrides() { return loadJson(OVERRIDES_FILE, {}); }

const num = (v) => (v == null || v === '' ? null : Number(v));
const mid = (bid, offer) => (bid != null && offer != null ? (bid + offer) / 2 : bid ?? offer ?? null);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Lightstreamer (optional — REST fallback if the package or server is unavailable) ──
let lsModule;
async function loadLightstreamer() {
  if (lsModule === undefined) {
    try { lsModule = await import('lightstreamer-client-node'); }
    catch { lsModule = null; console.warn('[ig] lightstreamer-client-node not installed — prices fall back to REST every 60 s'); }
  }
  return lsModule;
}

class IGSession {
  constructor({ apiKey, username, password, accountId, env }) {
    this.apiKey = apiKey;
    this.username = username;
    this.password = password;
    this.requestedAccountId = accountId || null;
    this.env = env;
    this.base = BASE[env];
    this.streamIntervalMs = 5000;

    this.cst = null;
    this.xst = null;
    this.accountId = null;
    this.lsEndpoint = null;
    this.loginPromise = null;

    this.nonTrading = new RateLimiter(Number(process.env.IG_NON_TRADING_PER_MIN) || 25);
    this.trading    = new RateLimiter(Number(process.env.IG_TRADING_PER_MIN) || 50);

    this.cache = cacheFor(env);
    this.epicToSym = new Map();
    this.markets = new Map();      // epic → { bid, offer, state, ts, rules?, rulesTs? }
    this.deals = [];               // orders placed this session, newest first (Alpaca order shape)
    this.snap = { account: null, positions: null, ts: 0, pending: null };

    this.ls = null;
    this.lsSub = null;
    this.lsLastUpdate = 0;
    this.timers = [];
    this.closed = false;
  }

  // ── Auth ─────────────────────────────────────────────────────────────────
  login() {
    if (!this.loginPromise) {
      this.loginPromise = this._login().finally(() => { this.loginPromise = null; });
    }
    return this.loginPromise;
  }

  async _login() {
    await this.nonTrading.take();
    let r;
    try {
      r = await fetch(`${this.base}/session`, {
        method: 'POST',
        headers: this._headers({ version: 2, auth: false }),
        body: JSON.stringify({ identifier: this.username, password: this.password }),
      });
    } catch (err) {
      throw new BrokerError(502, 'Could not reach IG', err.message);
    }
    const body = await readBody(r);
    if (r.status !== 200) {
      throw new BrokerError(r.status === 403 ? 429 : 401, 'IG rejected these credentials', body);
    }
    this.cst = r.headers.get('cst');
    this.xst = r.headers.get('x-security-token');
    if (!this.cst || !this.xst) throw new BrokerError(502, 'IG login returned no session tokens');
    this.lsEndpoint = body.lightstreamerEndpoint;

    const accounts = body.accounts || [];
    let target;
    if (this.requestedAccountId) {
      target = accounts.find(a => a.accountId === this.requestedAccountId);
      if (!target) throw new BrokerError(400, `Account ${this.requestedAccountId} is not on this IG login`);
    } else {
      const sb = accounts.filter(a => a.accountType === 'SPREADBET');
      target = sb.find(a => a.preferred) || sb[0];
      if (!target) throw new BrokerError(400, 'No spread betting account on this IG login', accounts.map(a => ({ accountId: a.accountId, accountType: a.accountType })));
    }
    if (target.accountType && target.accountType !== 'SPREADBET') {
      throw new BrokerError(400, `Account ${target.accountId} is ${target.accountType}, not a spread betting account`);
    }

    if (body.currentAccountId !== target.accountId) {
      await this.nonTrading.take();
      const sw = await fetch(`${this.base}/session`, {
        method: 'PUT',
        headers: this._headers({ version: 1 }),
        body: JSON.stringify({ accountId: target.accountId, defaultAccount: false }),
      });
      if (sw.status !== 200) throw new BrokerError(502, 'Could not switch to the spread betting account', await readBody(sw));
      this.cst = sw.headers.get('cst') || this.cst;
      this.xst = sw.headers.get('x-security-token') || this.xst;
    }
    this.accountId = target.accountId;
    this.accountInfo = { accountType: target.accountType || 'SPREADBET', currency: target.currency || body.currencyIsoCode };
    if (this.ls) this._restartStream();
  }

  _headers({ version = 1, auth = true, extra } = {}) {
    const h = {
      'X-IG-API-KEY': this.apiKey,
      'Content-Type': 'application/json; charset=UTF-8',
      'Accept':       'application/json; charset=UTF-8',
      'Version':      String(version),
      ...extra,
    };
    if (auth) { h.CST = this.cst; h['X-SECURITY-TOKEN'] = this.xst; }
    return h;
  }

  // Authenticated request; re-logs in once if the tokens have expired.
  async req(method, p, { body, version = 1, trading = false, extra, retried = false } = {}) {
    if (!this.cst) await this.login();
    await (trading ? this.trading : this.nonTrading).take();
    const r = await fetch(`${this.base}${p}`, {
      method,
      headers: this._headers({ version, extra }),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await readBody(r);
    const code = data?.errorCode || '';
    if (r.status === 401 && !retried && /token/i.test(code)) {
      this.cst = null;
      await this.login();
      return this.req(method, p, { body, version, trading, extra, retried: true });
    }
    if (r.status === 403 && /exceeded/i.test(code)) {
      return { status: 429, body: { message: `IG rate limit: ${code}`, errorCode: code } };
    }
    return { status: r.status, body: data };
  }

  // ── Ticker → epic ────────────────────────────────────────────────────────
  async epicFor(sym) {
    const ov = overrides();
    if (sym in ov) return this._remember(sym, ov[sym]);
    if (sym in this.cache.epics) return this._remember(sym, this.cache.epics[sym]);

    const key = `epic:${sym}`;
    if (!this.cache.inflight.has(key)) {
      this.cache.inflight.set(key, (async () => {
        const r = await this.req('GET', `/markets?searchTerm=${encodeURIComponent(sym)}`);
        if (r.status !== 200) return undefined; // don't cache transient failures
        const hits = (r.body?.markets || []).filter(m =>
          m.expiry === EXPIRY && m.instrumentType === 'SHARES' && m.epic.split('.').includes(sym));
        const pick = hits.find(m => !/all sessions/i.test(m.instrumentName)) || hits[0];
        const epic = pick ? pick.epic : null;
        this.cache.epics[sym] = epic;
        saveJson(cachePath(`ig-epics-${this.env}.json`), this.cache.epics);
        return epic;
      })().finally(() => this.cache.inflight.delete(key)));
    }
    return this._remember(sym, await this.cache.inflight.get(key));
  }

  _remember(sym, epic) {
    if (epic) this.epicToSym.set(epic, sym);
    return epic ?? null;
  }

  symFor(epic) { return this.epicToSym.get(epic) || epic; }

  async resolveAll(symbols) {
    const out = {};
    for (const s of symbols) out[s] = await this.epicFor(s); // sequential: searches share the rate limit
    return out;
  }

  // ── Market snapshots + dealing rules ────────────────────────────────────
  _setMarket(epic, fields) {
    this.markets.set(epic, { ...this.markets.get(epic), ...fields, ts: Date.now() });
  }

  async refreshMarkets() {
    const epics = [...this.epicToSym.keys()];
    for (let i = 0; i < epics.length; i += 50) {
      const r = await this.req('GET', `/markets?epics=${epics.slice(i, i + 50).join(',')}`, { version: 2 });
      for (const d of r.body?.marketDetails || []) {
        const s = d.snapshot || {};
        this._setMarket(d.instrument.epic, { bid: num(s.bid), offer: num(s.offer), state: s.marketStatus });
      }
    }
  }

  async marketDetails(epic) {
    const m = this.markets.get(epic);
    if (m?.rules && Date.now() - m.rulesTs < 3_600_000 && m.bid != null) return m;
    const r = await this.req('GET', `/markets/${encodeURIComponent(epic)}`, { version: 3 });
    if (r.status !== 200) throw new BrokerError(r.status === 429 ? 429 : 502, `IG market lookup failed for ${epic}`, r.body);
    const { instrument = {}, dealingRules = {}, snapshot = {} } = r.body;
    const currency = (instrument.currencies || []).find(c => c.isDefault)?.code || instrument.currencies?.[0]?.code || 'GBP';
    const rules = { currency, minSize: num(dealingRules.minDealSize?.value) || 0 };
    const fresh = this.lsLastUpdate && Date.now() - (m?.ts || 0) < 30_000;
    this._setMarket(epic, {
      rules, rulesTs: Date.now(),
      ...(fresh ? {} : { bid: num(snapshot.bid), offer: num(snapshot.offer), state: snapshot.marketStatus }),
    });
    return this.markets.get(epic);
  }

  // ── Lightstreamer price stream ──────────────────────────────────────────
  async startStream() {
    const ls = await loadLightstreamer();
    if (!ls || !this.lsEndpoint || this.closed) return;
    const { LightstreamerClient, Subscription } = ls;
    this.ls = new LightstreamerClient(this.lsEndpoint);
    this.ls.connectionDetails.setUser(this.accountId);
    this.ls.connectionDetails.setPassword(`CST-${this.cst}|XST-${this.xst}`);
    this.ls.addListener({
      onStatusChange: (s) => { if (/DISCONNECTED/.test(s)) this.lsLastUpdate = 0; },
      onServerError: (code, msg) => console.warn('[ig] Lightstreamer error', code, msg),
    });
    this.ls.connect();
    this._subscribePrices(Subscription);
  }

  _subscribePrices(Subscription = lsModule?.Subscription) {
    if (!this.ls || !Subscription) return;
    const epics = [...this.epicToSym.keys()];
    if (this.lsSub) { this.ls.unsubscribe(this.lsSub); this.lsSub = null; }
    if (!epics.length) return;
    const sub = new Subscription('MERGE', epics.map(e => `MARKET:${e}`), ['BID', 'OFFER', 'MARKET_STATE']);
    sub.setRequestedSnapshot('yes');
    sub.addListener({
      onItemUpdate: (u) => {
        const epic = u.getItemName().replace(/^MARKET:/, '');
        const fields = {};
        if (u.getValue('BID') != null)   fields.bid = num(u.getValue('BID'));
        if (u.getValue('OFFER') != null) fields.offer = num(u.getValue('OFFER'));
        if (u.getValue('MARKET_STATE'))  fields.state = u.getValue('MARKET_STATE').toUpperCase();
        this._setMarket(epic, fields);
        this.lsLastUpdate = Date.now();
      },
      onSubscriptionError: (code, msg) => console.warn('[ig] price subscription error', code, msg),
    });
    this.ls.subscribe(sub);
    this.lsSub = sub;
  }

  _restartStream() {
    try { this.ls?.disconnect(); } catch {}
    this.ls = null;
    this.lsSub = null;
    this.startStream().catch(err => console.warn('[ig] stream restart failed', err.message));
  }

  // Background work after connect: resolve the universe, start streaming, keep a REST fallback.
  async warmUp(symbols) {
    await this.resolveAll(symbols);
    if (this.closed) return;
    await this.refreshMarkets().catch(() => {});
    await this.startStream().catch(err => console.warn('[ig] Lightstreamer unavailable:', err.message));
    const t = setInterval(() => {
      if (Date.now() - this.lsLastUpdate > MARKET_REFRESH_MS) this.refreshMarkets().catch(() => {});
    }, MARKET_REFRESH_MS);
    t.unref?.();
    this.timers.push(t);
  }

  // ── Account / positions (Alpaca-shaped) ─────────────────────────────────
  async rawAccount() {
    const r = await this.req('GET', '/accounts');
    if (r.status !== 200) return r;
    const a = (r.body.accounts || []).find(x => x.accountId === this.accountId);
    if (!a) return { status: 404, body: { message: `Account ${this.accountId} not found` } };
    const b = a.balance || {};
    const equity = (b.balance || 0) + (b.profitLoss || 0);
    return {
      status: 200,
      body: {
        id:              a.accountId,
        account_number:  a.accountId,
        status:          a.status === 'ENABLED' ? 'ACTIVE' : a.status,
        currency:        a.currency,
        account_type:    a.accountType,
        equity:          String(equity),
        portfolio_value: String(equity),
        cash:            String(b.balance || 0),
        buying_power:    String(b.available || 0),
        unrealized_pl:   String(b.profitLoss || 0),
        deposit:         String(b.deposit || 0),
        trading_blocked: a.status !== 'ENABLED',
      },
    };
  }

  async rawPositions() {
    const r = await this.req('GET', '/positions', { version: 2 });
    if (r.status !== 200) return r;
    const bySym = new Map();
    for (const { position: p, market: m } of r.body.positions || []) {
      const sym = this.symFor(m.epic);
      const live = this.markets.get(m.epic);
      const bid = live?.bid ?? num(m.bid);
      const offer = live?.offer ?? num(m.offer);
      const signed = p.direction === 'BUY' ? p.size : -p.size;
      const upl = p.direction === 'BUY' ? (bid - p.level) * p.size : (p.level - offer) * p.size;
      const g = bySym.get(sym) || { sym, epic: m.epic, qty: 0, cost: 0, size: 0, upl: 0, bid, offer, dealIds: [], currency: p.currency };
      g.qty += signed;
      g.size += p.size;
      g.cost += p.level * p.size;
      g.upl += Number.isFinite(upl) ? upl : 0;
      g.dealIds.push(p.dealId);
      bySym.set(sym, g);
    }
    const positions = [...bySym.values()].map(g => {
      const current = g.qty >= 0 ? g.bid : g.offer;
      return {
        symbol:          g.sym,
        epic:            g.epic,
        qty:             String(g.qty),
        side:            g.qty >= 0 ? 'long' : 'short',
        avg_entry_price: String(g.size ? g.cost / g.size : 0),
        current_price:   String(current ?? 0),
        market_value:    String((current ?? 0) * g.qty),
        cost_basis:      String(g.cost),
        unrealized_pl:   String(g.upl),
        unrealized_plpc: String(g.cost ? g.upl / g.cost : 0),
        currency:        g.currency,
        deal_ids:        g.dealIds,
      };
    });
    return { status: 200, body: positions };
  }

  // Cached account + positions so several SSE streams share one REST budget.
  async cachedSnapshot(force = false) {
    if (!force && this.snap.account && Date.now() - this.snap.ts < SNAPSHOT_TTL_MS) return this.snap;
    if (!this.snap.pending) {
      this.snap.pending = (async () => {
        const [account, positions] = await Promise.all([this.rawAccount(), this.rawPositions()]);
        if (account.status === 200) this.snap.account = account.body;
        if (positions.status === 200) this.snap.positions = positions.body;
        this.snap.ts = Date.now();
        return { account, positions };
      })().finally(() => { this.snap.pending = null; });
    }
    const fresh = await this.snap.pending;
    return { ...this.snap, fresh };
  }

  async account() {
    const s = await this.cachedSnapshot();
    return s.account ? { status: 200, body: s.account } : s.fresh.account;
  }

  async positions() {
    const s = await this.cachedSnapshot();
    return s.positions ? { status: 200, body: s.positions } : s.fresh.positions;
  }

  // IG has no order history comparable to Alpaca's, so this lists deals placed through this session.
  async orders() { return { status: 200, body: this.deals.slice(0, 100) }; }

  clock() {
    const states = [...this.markets.values()].map(m => m.state).filter(Boolean);
    return {
      is_open: states.some(s => s === 'TRADEABLE'),
      next_open: null,
      next_close: null,
      timestamp: new Date().toISOString(),
      source: 'ig',
    };
  }

  prices() {
    const out = {};
    for (const [epic, m] of this.markets) {
      const p = mid(m.bid, m.offer);
      if (p != null) out[this.symFor(epic)] = p;
    }
    return out;
  }

  async snapshot() {
    const s = await this.cachedSnapshot();
    return {
      account:   s.account,
      positions: s.positions || [],
      orders:    this.deals.slice(0, 50),
      clock:     this.clock(),
      prices:    this.prices(),
    };
  }

  // ── Dealing ──────────────────────────────────────────────────────────────
  // GET /confirms/{ref} can 404 for a moment after the deal is submitted.
  async confirm(dealReference) {
    for (let i = 0; i < 6; i++) {
      const r = await this.req('GET', `/confirms/${encodeURIComponent(dealReference)}`);
      if (r.status === 200) return r.body;
      if (r.status !== 404) throw new BrokerError(502, 'IG deal confirmation failed', r.body);
      await sleep(400 * (i + 1));
    }
    throw new BrokerError(504, `No confirmation from IG for deal ${dealReference}`);
  }

  _recordDeal({ ref, sym, epic, side, size, conf, submittedAt }) {
    const accepted = conf.dealStatus === 'ACCEPTED';
    const order = {
      id:               conf.dealId || ref,
      client_order_id:  ref,
      symbol:           sym,
      epic,
      side:             side.toLowerCase(),
      qty:              String(size),
      filled_qty:       accepted ? String(conf.size ?? size) : '0',
      filled_avg_price: accepted && conf.level != null ? String(conf.level) : null,
      type:             'market',
      time_in_force:    'day',
      status:           accepted ? 'filled' : 'rejected',
      reason:           conf.reason,
      submitted_at:     submittedAt,
      created_at:       submittedAt,
      filled_at:        accepted ? new Date().toISOString() : null,
    };
    this.deals.unshift(order);
    this.deals.length = Math.min(this.deals.length, 500);
    this.snap.ts = 0; // positions changed — refresh on next read
    return order;
  }

  // Accepts the frontend's Alpaca-style order: { symbol, side, type, notional | qty }.
  // notional is in account currency; qty is taken as an IG stake (£ per point).
  async placeOrder(order) {
    const { symbol, side, type = 'market', notional, qty } = order || {};
    if (!symbol || !['buy', 'sell'].includes(side)) {
      return { status: 422, body: { message: 'symbol and side (buy|sell) are required' } };
    }
    if (type !== 'market') return { status: 422, body: { message: 'IG adapter only supports market orders' } };
    const epic = await this.epicFor(symbol);
    if (!epic) return { status: 422, body: { message: `${symbol} has no IG spread bet (DFB) market` } };

    const m = await this.marketDetails(epic);
    const direction = side === 'buy' ? 'BUY' : 'SELL';
    const price = direction === 'BUY' ? m.offer : m.bid;
    let size;
    if (qty != null) size = Number(qty);
    else if (notional != null) {
      if (!price) return { status: 422, body: { message: `No IG price for ${symbol} — market may be closed` } };
      size = Number(notional) / price; // exposure = stake × price in points
    }
    size = Math.floor(size * 100) / 100;
    if (!(size > 0) || size < m.rules.minSize) {
      return { status: 422, body: { message: `Stake £${size || 0}/pt is below IG's minimum of £${m.rules.minSize}/pt for ${symbol}` } };
    }

    const submittedAt = new Date().toISOString();
    const r = await this.req('POST', '/positions/otc', {
      version: 2, trading: true,
      body: {
        epic, expiry: EXPIRY, direction, size,
        orderType: 'MARKET', currencyCode: m.rules.currency,
        forceOpen: false, guaranteedStop: false,
      },
    });
    if (r.status !== 200 || !r.body?.dealReference) {
      return { status: r.status === 200 ? 502 : r.status, body: { message: r.body?.errorCode || 'IG did not accept the order', detail: r.body } };
    }
    const conf = await this.confirm(r.body.dealReference);
    const rec = this._recordDeal({ ref: r.body.dealReference, sym: symbol, epic, side: direction, size, conf, submittedAt });
    if (conf.dealStatus !== 'ACCEPTED') {
      return { status: 422, body: { ...rec, message: `IG rejected: ${conf.reason || 'UNKNOWN'}` } };
    }
    return { status: 200, body: rec };
  }

  // Close every open IG position on the symbol's epic.
  async closePosition(symbol) {
    const epic = await this.epicFor(symbol);
    if (!epic) return { status: 200, body: { ok: true, notFound: true } };
    const r = await this.req('GET', '/positions', { version: 2 });
    if (r.status !== 200) return r;
    const open = (r.body.positions || []).filter(x => x.market.epic === epic);
    if (!open.length) return { status: 200, body: { ok: true, notFound: true } };

    const results = [];
    for (const { position: p } of open) {
      const direction = p.direction === 'BUY' ? 'SELL' : 'BUY';
      const submittedAt = new Date().toISOString();
      // IG closes with POST + _method: DELETE because DELETE bodies are widely unsupported.
      const c = await this.req('POST', '/positions/otc', {
        version: 1, trading: true, extra: { _method: 'DELETE' },
        body: { dealId: p.dealId, direction, size: p.size, orderType: 'MARKET' },
      });
      if (c.status !== 200 || !c.body?.dealReference) {
        results.push({ dealId: p.dealId, ok: false, error: c.body });
        continue;
      }
      const conf = await this.confirm(c.body.dealReference);
      this._recordDeal({ ref: c.body.dealReference, sym: symbol, epic, side: direction, size: p.size, conf, submittedAt });
      results.push({ dealId: p.dealId, ok: conf.dealStatus === 'ACCEPTED', reason: conf.reason });
    }
    const ok = results.every(x => x.ok);
    return { status: ok ? 200 : 422, body: { ok, closed: results } };
  }

  async cancelOrder(id) {
    const r = await this.req('DELETE', `/workingorders/otc/${encodeURIComponent(id)}`, { version: 2, trading: true });
    if (r.status !== 200) return r;
    const conf = await this.confirm(r.body.dealReference);
    return { status: conf.dealStatus === 'ACCEPTED' ? 200 : 422, body: { ok: conf.dealStatus === 'ACCEPTED', reason: conf.reason } };
  }

  // ── Daily bars (Alpaca shape: { bars: { SYM: [{ t, o, h, l, c, v }] } }) ──
  async bars(symbols) {
    const out = {};
    for (const sym of symbols) {
      const epic = await this.epicFor(sym);
      if (!epic) continue;
      const bars = await this._barsFor(epic).catch(err => {
        console.warn('[ig] bars failed for', sym, err.message);
        return this.cache.bars[epic]?.bars || [];
      });
      if (bars.length) out[sym] = bars;
    }
    return { status: 200, body: { bars: out } };
  }

  async _barsFor(epic) {
    const today = new Date().toISOString().slice(0, 10);
    const entry = this.cache.bars[epic];
    // caches from before BARS_INITIAL was raised are refetched in full once
    const short = entry && !entry.full && entry.bars.length < BARS_INITIAL * 0.9;
    if (entry?.fetchedOn === today && !short) return entry.bars;

    const key = `bars:${epic}`;
    if (this.cache.inflight.has(key)) return this.cache.inflight.get(key);
    const job = (async () => {
      const last = short ? null : entry?.bars?.at(-1)?.t;
      const qs = last
        ? `resolution=DAY&from=${last.slice(0, 10)}T00:00:00&to=${today}T23:59:59&pageSize=0`
        : `resolution=DAY&max=${BARS_INITIAL}&pageSize=0`;
      const r = await this.req('GET', `/prices/${encodeURIComponent(epic)}?${qs}`, { version: 3 });
      if (r.status !== 200) {
        if (/allowance/i.test(r.body?.errorCode || r.body?.message || '')) {
          console.warn('[ig] historical price allowance exhausted — using cached bars');
        }
        return entry?.bars || [];
      }
      const fetched = (r.body.prices || []).map(p => ({
        t: new Date((p.snapshotTimeUTC || p.snapshotTime).replace(/\//g, '-').replace(' ', 'T') + (p.snapshotTimeUTC ? 'Z' : '')).toISOString(),
        o: mid(num(p.openPrice?.bid), num(p.openPrice?.ask)),
        h: mid(num(p.highPrice?.bid), num(p.highPrice?.ask)),
        l: mid(num(p.lowPrice?.bid), num(p.lowPrice?.ask)),
        c: mid(num(p.closePrice?.bid), num(p.closePrice?.ask)),
        v: p.lastTradedVolume ?? 0,
      })).filter(b => b.c > 0);
      const byDay = new Map((entry?.bars || []).map(b => [b.t.slice(0, 10), b]));
      for (const b of fetched) byDay.set(b.t.slice(0, 10), b);
      const bars = [...byDay.values()].sort((a, b) => a.t.localeCompare(b.t)).slice(-BARS_KEEP);
      this.cache.bars[epic] = { bars, fetchedOn: today, full: entry?.full || !last };
      saveJson(cachePath(`ig-bars-${this.env}.json`), this.cache.bars);
      const left = r.body.metadata?.allowance?.remainingAllowance;
      if (left != null && left < 1000) console.warn(`[ig] historical price allowance low: ${left} points left this week`);
      return bars;
    })().finally(() => this.cache.inflight.delete(key));
    this.cache.inflight.set(key, job);
    return job;
  }

  // ── Teardown ─────────────────────────────────────────────────────────────
  close() {
    this.closed = true;
    this.timers.forEach(clearInterval);
    try { this.ls?.disconnect(); } catch {}
    if (this.cst) {
      fetch(`${this.base}/session`, { method: 'DELETE', headers: this._headers({ version: 1 }) }).catch(() => {});
    }
  }
}

export const ig = {
  id: 'ig',
  name: 'IG',
  endpoints: BASE,

  // Log in, switch to the spread betting account, and return a live session.
  // universe: tickers to resolve to epics and stream prices for, in the background.
  async connect({ apiKey, username, password, accountId, env }, { universe = [] } = {}) {
    if (!apiKey || !username || !password || !BASE[env]) {
      throw new BrokerError(400, 'Missing or invalid fields (apiKey, username, password, env)');
    }
    const session = new IGSession({ apiKey, username, password, accountId, env });
    await session.login();
    const acct = await session.rawAccount();
    if (acct.status !== 200) throw new BrokerError(502, 'Logged in to IG but could not read the account', acct.body);
    session.warmUp(universe).catch(err => console.warn('[ig] warm-up failed:', err.message));
    const a = acct.body;
    return {
      session,
      account: {
        id:             a.id,
        status:         a.status,
        currency:       a.currency,
        accountType:    a.account_type,
        equity:         parseFloat(a.equity),
        buyingPower:    parseFloat(a.buying_power),
        cash:           parseFloat(a.cash),
        portfolioValue: parseFloat(a.portfolio_value),
        tradingBlocked: a.trading_blocked,
      },
    };
  },
};

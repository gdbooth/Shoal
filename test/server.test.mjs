import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';

// A fake Alpaca paper account that is mostly invested in a stock outside the watchlist, plus daily bars
// where stock Sk trends up faster the larger k is.
const SYMS = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'];
const state = { cash: 1000, positions: { OLD: 9000 }, orders: [], closed: [], open: true };
let mock, server, base, token;

function bars() {
  const out = {}, days = [];
  const d = new Date(); d.setUTCHours(0, 0, 0, 0);
  while (days.length < 320) { d.setUTCDate(d.getUTCDate() - 1); const wd = d.getUTCDay(); if (wd && wd < 6) days.unshift(d.toISOString()); }
  SYMS.forEach((s, k) => { let p = 50; out[s] = days.map((t, i) => { p *= 1 + 0.0004 * (k + 1) + 0.002 * Math.sin(i + k); return { t, o: p, h: p * 1.01, l: p * 0.99, c: p, v: 1e6 }; }); });
  return out;
}

before(async () => {
  const m = express();
  m.use(express.json());
  m.use((req, res, next) => (req.get('APCA-API-KEY-ID') === 'PKSERVER1234567890' ? next() : res.status(403).json({ message: 'forbidden' })));
  const equity = () => state.cash + Object.values(state.positions).reduce((a, b) => a + b, 0);
  m.get('/v2/account', (_q, r) => r.json({ id: 'acc-s', status: 'ACTIVE', equity: String(equity()), cash: String(state.cash), buying_power: String(state.cash * 2), portfolio_value: String(equity()) }));
  m.get('/v2/positions', (_q, r) => r.json(Object.entries(state.positions).map(([symbol, v]) => ({ symbol, qty: '1', market_value: String(v) }))));
  m.get('/v2/clock', (_q, r) => r.json({ is_open: state.open, next_open: '2026-11-20T14:30:00Z' }));
  m.get('/v2/stocks/bars', (_q, r) => r.json({ bars: bars(), next_page_token: null }));
  m.post('/v2/orders', (q, r) => { const n = +q.body.notional; state.cash -= n; state.positions[q.body.symbol] = (state.positions[q.body.symbol] || 0) + n; state.orders.push(q.body); r.json({ id: 'o' + state.orders.length, status: 'accepted', symbol: q.body.symbol }); });
  m.delete('/v2/positions/:s', (q, r) => { state.cash += state.positions[q.params.s] || 0; delete state.positions[q.params.s]; state.closed.push(q.params.s); r.status(204).end(); });
  mock = await new Promise(res => { const s = m.listen(0, () => res(s)); });
  const url = `http://127.0.0.1:${mock.address().port}`;
  Object.assign(process.env, {
    ALPACA_PAPER_URL: url, ALPACA_DATA_URL: url, PORT: '0', VERCEL: '1', SHOAL_SESSION_SECRET: 'test-secret',
    SHOAL_ACCESS_CODE: 'open-sesame', CRON_SECRET: 'cron-secret-xyz', ALPACA_KEY_ID: 'PKSERVER1234567890', ALPACA_SECRET: 's', ALPACA_ENV: 'paper',
    SHOAL_WATCHLIST: SYMS.join(','), SHOAL_TOPK: '3', SHOAL_STRATEGY: 'tilt', // these tests check Rank & tilt's orders; the team is tested in trader.test.mjs
    SHOAL_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'shoal-srv-')),
  });
  ({ server } = await import('../server.js'));
  if (!server.listening) await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); mock.close(); });

const call = (p, { headers = {}, ...opts } = {}) => fetch(base + p, { ...opts, headers: { 'Content-Type': 'application/json', ...headers } })
  .then(async r => ({ status: r.status, headers: r.headers, body: await r.json().catch(() => null) }));
const cron = (q = '') => call('/api/cron/tilt' + q, { headers: { Authorization: 'Bearer cron-secret-xyz' } });

test('connecting needs the access code; health says so', async () => {
  assert.equal((await call('/api/health')).body.accessCode, true);
  const body = JSON.stringify({ keyId: 'PKSERVER1234567890', secret: 's', env: 'paper' });
  const no = await call('/api/connect', { method: 'POST', body });
  assert.equal(no.status, 403);
  assert.equal(no.body.needAccessCode, true);
  const wrong = await call('/api/connect', { method: 'POST', body, headers: { 'x-shoal-access': 'nope' } });
  assert.equal(wrong.status, 403);
  const ok = await call('/api/connect', { method: 'POST', body, headers: { 'x-shoal-access': 'open-sesame' } });
  assert.equal(ok.status, 200);
  token = ok.body.token;
});

test('only the app\'s own address may call the API from a browser; security headers set', async () => {
  const own = await call('/api/health', { headers: { Origin: base.replace('http://', 'https://') } });
  assert.equal(own.headers.get('access-control-allow-origin'), base.replace('http://', 'https://'));
  const other = await call('/api/health', { headers: { Origin: 'https://evil.example' } });
  assert.equal(other.headers.get('access-control-allow-origin'), null);
  assert.equal(own.headers.get('x-frame-options'), 'DENY');
  assert.equal(own.headers.get('x-content-type-options'), 'nosniff');
});

test('the token is only accepted in the Authorization header', async () => {
  assert.equal((await call(`/api/account?token=${token}`)).status, 401);
  assert.equal((await call('/api/account', { headers: { Authorization: 'Bearer ' + token } })).status, 200);
});

test('server trading: status for the browser, no secrets', async () => {
  const r = await call('/api/server-trading', { headers: { Authorization: 'Bearer ' + token } });
  assert.equal(r.status, 200);
  assert.equal(r.body.enabled, true);
  assert.equal(r.body.sameAccount, true);
  assert.equal(r.body.topK, 3);
  assert.ok(!JSON.stringify(r.body).includes('PKSERVER') && !JSON.stringify(r.body).includes('cron-secret'));
});

test('the cron job refuses callers without the cron secret', async () => {
  assert.equal((await call('/api/cron/tilt')).status, 401);
  assert.equal((await call('/api/cron/tilt', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
});

test('dry run: plan only, no orders', async () => {
  const r = await cron('?dry=1');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.picks, ['S6', 'S5', 'S4']);
  assert.deepEqual(r.body.sells, ['OLD']);
  assert.equal(state.orders.length + state.closed.length, 0);
});

test('first run sells what is not a pick and waits for a full share; the next run buys the picks', async () => {
  const r1 = await cron();
  assert.deepEqual(r1.body.sells, ['OLD']);
  assert.deepEqual(r1.body.buys, []); // $1000 cash < one $3000 share while OLD is still being sold
  assert.deepEqual(state.closed, ['OLD']);
  const r2 = await cron();
  assert.deepEqual(r2.body.sells, []);
  assert.deepEqual(r2.body.buys.map(b => b.sym), ['S6', 'S5', 'S4']);
  assert.ok(r2.body.buys.every(b => Math.abs(b.notional - 3000) < 1));
  const r3 = await cron(); // nothing left to do
  assert.deepEqual([r3.body.sells, r3.body.buys], [[], []]);
});

test('market closed: the job does nothing', async () => {
  state.open = false;
  const r = await cron();
  assert.equal(r.body.skipped, 'market closed');
  state.open = true;
});

test('preview uses the browser\'s own session for the same account', async () => {
  const r = await call('/api/server-trading/preview', { headers: { Authorization: 'Bearer ' + token } });
  assert.equal(r.status, 200);
  assert.equal(r.body.dry, true);
  assert.deepEqual(r.body.picks, ['S6', 'S5', 'S4']);
});

test('engine tick: needs the scheduler secret; runs by the market clock and reports', async () => {
  assert.equal((await call('/api/engine/tick', { method: 'POST' })).status, 401);
  assert.equal((await call('/api/engine/tick', { method: 'POST', headers: { Authorization: 'Bearer nope' } })).status, 401);
  const dry = await call('/api/engine/tick?dry=1', { method: 'POST', headers: { Authorization: 'Bearer cron-secret-xyz' } });
  assert.equal(dry.status, 200, JSON.stringify(dry.body));
  assert.equal(dry.body.ok, true);
  assert.ok(Array.isArray(dry.body.due));
  const st = await call('/api/engine/status');
  assert.equal(st.status, 200);
  assert.equal(st.body.enabled, true);
  assert.equal(st.body.storage, 'temporary files (not durable: connect a Blob store)');
  assert.ok(!JSON.stringify(st.body).includes('cron-secret') && !JSON.stringify(st.body).includes('PKSERVER'));
});

test('agent scorecard: empty until built; building reads prices only and stores the scorecard', async () => {
  const before = await call('/api/engine/learning');
  assert.equal(before.status, 200);
  const orders = state.orders.length;
  const r = await call('/api/engine/learn', { method: 'POST' });
  assert.ok([200, 502].includes(r.status));
  assert.equal(state.orders.length, orders); // never trades
  if (r.status === 200) {
    assert.equal(r.body.scorecard.agents.length, 7);
    const after = await call('/api/engine/learning');
    assert.equal(after.body.scorecard.agents.length, 7);
    assert.ok(after.body.weights);
  } else assert.match(r.body.error, /days of history/);
});

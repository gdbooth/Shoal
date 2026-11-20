import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { startMockIG, MOCK_API_KEY } from './mock-ig.mjs';

let mock, server, base, token, sessions;
const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoal-ig-'));

before(async () => {
  mock = await startMockIG();
  process.env.IG_DEMO_URL = mock.url;
  process.env.SHOAL_CACHE_DIR = cacheDir;
  process.env.PORT = '0';
  process.env.SHOAL_SESSION_SECRET = 'test-secret'; // exercise sealed tokens, as deployed on Vercel
  ({ server } = await import('../server.js'));
  ({ sessions } = await import('../app.js'));
  if (!server.listening) await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  mock.srv.close();
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

const api = (p, opts = {}) => fetch(base + p, {
  ...opts,
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...opts.headers },
}).then(async r => ({ status: r.status, body: await r.json() }));

test('rejects bad IG credentials', async () => {
  const r = await api('/api/connect', { method: 'POST', body: JSON.stringify({ broker: 'ig', env: 'paper', apiKey: MOCK_API_KEY, username: 'user', password: 'nope' }) });
  assert.equal(r.status, 401);
});

test('connects and switches to the spread betting account', async () => {
  const r = await api('/api/connect', { method: 'POST', body: JSON.stringify({ broker: 'ig', env: 'paper', apiKey: MOCK_API_KEY, username: 'user', password: 'pw', symbols: ['AAPL', 'MSFT', 'ZZZZ'] }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  token = r.body.token;
  assert.equal(r.body.broker.id, 'ig');
  assert.equal(r.body.account.id, 'SB1');
  assert.equal(r.body.account.equity, 10000);
  assert.equal(mock.state.current, 'SB1');
  assert.ok(mock.state.calls.includes('PUT /session v1'));
});

test('account is Alpaca-shaped', async () => {
  const r = await api('/api/account');
  assert.equal(r.status, 200);
  assert.equal(r.body.buying_power, '9500');
  assert.equal(r.body.portfolio_value, '10000');
});

test('notional market order → £/pt stake on the DFB epic, confirmed', async () => {
  const r = await api('/api/orders', { method: 'POST', body: JSON.stringify({ symbol: 'AAPL', notional: '2000', side: 'buy', type: 'market', time_in_force: 'day' }) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'filled');
  assert.equal(r.body.epic, 'UA.D.AAPL.DAILY.IP');
  assert.equal(r.body.qty, '0.09'); // floor(2000 / 21844, 2dp)
  assert.equal(r.body.filled_avg_price, '21844');
});

test('stake below the IG minimum is refused before dealing', async () => {
  const r = await api('/api/orders', { method: 'POST', body: JSON.stringify({ symbol: 'AAPL', notional: '100', side: 'buy', type: 'market' }) });
  assert.equal(r.status, 422);
  assert.match(r.body.message, /minimum/);
});

test('IG rejection surfaces as 422 with the reason', async () => {
  const r = await api('/api/orders', { method: 'POST', body: JSON.stringify({ symbol: 'MSFT', qty: '500', side: 'sell', type: 'market' }) });
  assert.equal(r.status, 422);
  assert.match(r.body.message, /INSUFFICIENT_FUNDS/);
});

test('unknown ticker is refused', async () => {
  const r = await api('/api/orders', { method: 'POST', body: JSON.stringify({ symbol: 'ZZZZ', notional: '1000', side: 'buy' }) });
  assert.equal(r.status, 422);
  assert.match(r.body.message, /no IG spread bet/);
});

test('positions are Alpaca-shaped and keyed by ticker', async () => {
  const r = await api('/api/positions');
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 1);
  const p = r.body[0];
  assert.equal(p.symbol, 'AAPL');
  assert.equal(p.side, 'long');
  assert.equal(Number(p.qty), 0.09);
  assert.ok(Math.abs(Number(p.unrealized_pl) - (21840 - 21844) * 0.09) < 1e-9);
});

test('orders lists deals placed this session', async () => {
  const r = await api('/api/orders');
  assert.deepEqual(r.body.map(o => o.status), ['rejected', 'filled']);
});

test('bars come back in Alpaca shape and are cached on disk', async () => {
  const r = await api('/api/bars?symbols=AAPL,MSFT,ZZZZ');
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body.bars).sort(), ['AAPL', 'MSFT']);
  assert.equal(r.body.bars.AAPL.length, 220);
  assert.ok(r.body.bars.AAPL.every(b => b.c > 0 && b.t));
  const before = mock.state.calls.filter(c => c.startsWith('GET /prices')).length;
  await api('/api/bars?symbols=AAPL');
  assert.equal(mock.state.calls.filter(c => c.startsWith('GET /prices')).length, before, 'second call served from cache');
  assert.ok(fs.existsSync(path.join(cacheDir, 'ig-bars-paper.json')));
});

const coldCache = async () => { for (const s of sessions.values()) { const x = await s; if (x?.cache) for (const k of Object.keys(x.cache.bars)) delete x.cache.bars[k]; } };

test('cold server with a browser copy only fetches the days since it', async () => {
  await coldCache();
  mock.state.priceQueries = [];
  const r = await api('/api/bars?symbols=AAPL&since=2026-11-10');
  assert.equal(r.status, 200);
  const q = mock.state.priceQueries.at(-1);
  assert.equal(q.max, undefined, 'no full-history request');
  assert.match(q.from, /^2026-11-10T00:00:00/);
  assert.ok(r.body.bars.AAPL.length >= 1);
});

test('exhausted history allowance is reported to the browser', async () => {
  await coldCache();
  mock.state.allowanceOut = true;
  try {
    const r = await api('/api/bars?symbols=AAPL,MSFT');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.bars, {});
    assert.equal(r.body.warning, 'allowance');
  } finally { mock.state.allowanceOut = false; }
});

test('stream pushes account, positions, clock and prices', async () => {
  const ctl = new AbortController();
  // the token itself is refused in the URL; a one-minute ticket is used instead
  const bad = await fetch(`${base}/api/stream?token=${token}`);
  assert.equal(bad.status, 401);
  const { ticket } = (await api('/api/stream-ticket', { method: 'POST' })).body;
  assert.ok(ticket && ticket !== token);
  const r = await fetch(`${base}/api/stream?ticket=${encodeURIComponent(ticket)}`, { signal: ctl.signal });
  assert.equal(r.status, 200);
  const reader = r.body.getReader();
  let buf = '';
  while (!buf.includes('\n\n')) buf += new TextDecoder().decode((await reader.read()).value);
  ctl.abort();
  const msg = JSON.parse(buf.slice(6, buf.indexOf('\n\n')));
  assert.equal(msg.account.id, 'SB1');
  assert.equal(msg.positions[0].symbol, 'AAPL');
  assert.equal(msg.clock.is_open, true);
  assert.equal(msg.prices.AAPL, 21842);
});

test('closing a position flattens it on IG', async () => {
  const r = await api('/api/positions/AAPL', { method: 'DELETE' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.closed.length, 1);
  assert.equal(mock.state.positions.length, 0);
  assert.ok(mock.state.calls.includes('POST /positions/otc v1'));
});

test('expired tokens trigger one re-login, then the request succeeds', async () => {
  const logins = () => mock.state.calls.filter(c => c === 'POST /session v2').length;
  const n = logins();
  mock.state.gen++; // IG invalidates the CST / X-SECURITY-TOKEN pair
  const r = await api('/api/positions/MSFT', { method: 'DELETE' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(logins(), n + 1);
});

test('sealed token survives a cold start (new instance, empty session store)', async () => {
  assert.match(token, /^s1\./);
  const logins = () => mock.state.calls.filter(c => c === 'POST /session v2').length;
  const n = logins();
  sessions.clear();
  const [a, b] = await Promise.all([api('/api/account'), api('/api/positions')]);
  assert.equal(a.status, 200);
  assert.equal(a.body.id, 'SB1');
  assert.equal(b.status, 200);
  assert.equal(logins(), n + 1, 'concurrent requests share one re-login');
});

test('tampered token is rejected', async () => {
  const saved = token;
  token = saved.slice(0, -4) + (saved.endsWith('AAAA') ? 'BBBB' : 'AAAA');
  sessions.clear();
  assert.equal((await api('/api/account')).status, 401);
  token = saved;
});

test('disconnect drops the session', async () => {
  await api('/api/disconnect', { method: 'DELETE' });
  const r = await api('/api/account');
  assert.equal(r.status, 401);
});

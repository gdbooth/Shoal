import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

// Regression check: the Alpaca adapter still passes Alpaca's JSON straight through.
let mock, server, base, token;
const seen = [];

before(async () => {
  const m = express();
  m.use(express.json());
  m.use((req, res, next) => {
    seen.push(`${req.method} ${req.originalUrl}`);
    if (req.get('APCA-API-KEY-ID') !== 'PKTESTKEY1234567890') return res.status(403).json({ message: 'forbidden' });
    next();
  });
  m.get('/v2/account', (_q, r) => r.json({ id: 'acc-1', status: 'ACTIVE', equity: '1000', buying_power: '2000', cash: '1000', portfolio_value: '1000' }));
  m.get('/v2/positions', (_q, r) => r.json([{ symbol: 'AAPL', qty: '2' }]));
  m.get('/v2/orders', (_q, r) => r.json([]));
  m.get('/v2/clock', (_q, r) => r.json({ is_open: true }));
  m.post('/v2/orders', (q, r) => r.json({ id: 'o1', ...q.body }));
  m.delete('/v2/positions/:s', (q, r) => r.status(q.params.s === 'AAPL' ? 204 : 404).end());
  m.get('/v2/stocks/bars', (q, r) => r.json({ bars: { [q.query.symbols]: [{ c: 1 }] } }));
  mock = await new Promise(res => { const s = m.listen(0, () => res(s)); });
  const url = `http://127.0.0.1:${mock.address().port}`;
  Object.assign(process.env, { ALPACA_PAPER_URL: url, ALPACA_DATA_URL: url, PORT: '0' });
  ({ server } = await import('../server.js'));
  if (!server.listening) await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server.close(); mock.close(); });

const api = (p, opts = {}) => fetch(base + p, {
  ...opts,
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
}).then(async r => ({ status: r.status, body: await r.json() }));

test('connect defaults to Alpaca and keeps the old response shape', async () => {
  const r = await api('/api/connect', { method: 'POST', body: JSON.stringify({ keyId: 'PKTESTKEY1234567890', secret: 's', env: 'paper' }) });
  assert.equal(r.status, 200);
  token = r.body.token;
  assert.equal(r.body.broker.id, 'alpaca');
  assert.equal(r.body.account.buyingPower, 2000);
});

test('bad keys → 401', async () => {
  const r = await api('/api/connect', { method: 'POST', body: JSON.stringify({ keyId: 'PKWRONG', secret: 's', env: 'paper' }) });
  assert.equal(r.status, 401);
});

test('orders, positions, bars pass through', async () => {
  assert.equal((await api('/api/orders', { method: 'POST', body: JSON.stringify({ symbol: 'AAPL', side: 'buy' }) })).body.id, 'o1');
  assert.equal((await api('/api/positions')).body[0].symbol, 'AAPL');
  assert.deepEqual(await api('/api/positions/AAPL', { method: 'DELETE' }), { status: 200, body: { ok: true } });
  assert.deepEqual((await api('/api/positions/MSFT', { method: 'DELETE' })).body, { ok: true, notFound: true });
  assert.equal((await api('/api/bars?symbols=AAPL')).body.bars.AAPL[0].c, 1);
  await api('/api/orders?token=x&status=open');
  assert.ok(seen.includes('GET /v2/orders?status=open&limit=100'), 'token param stripped');
});

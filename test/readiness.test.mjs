// The go-live check (step 6): collects a month, passes only on the agreed bar, notifies on changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { goLiveCheck } from '../readiness.js';
import { engineTick } from '../engine.js';
import { sizingEquity, serverConfig } from '../trader.js';

// n weekday reports ending 2026-12-31, newest first, Shoal and SPY daily returns from functions of k
function reports(n, shoal, spy, extra = () => ({}), end = '2026-12-31') {
  const out = [];
  for (let d = new Date(end + 'T12:00:00Z'); out.length < n; d = new Date(d - 864e5)) if (d.getUTCDay() % 6) out.push({ date: d.toISOString().slice(0, 10) });
  return out.map((r, k) => ({ ...r, dayReturnPct: shoal(k), spyPct: spy(k), fills: 2, rejected: 0, ...extra(k) }));
}
const wobble = (base, amp) => (k) => base + amp * Math.sin(k * 1.7);

test('collecting until 21 trading days are in', () => {
  const r = goLiveCheck(reports(15, wobble(0.2, 0.5), wobble(0.05, 0.6)));
  assert.equal(r.status, 'collecting'); assert.equal(r.days, 15); assert.match(r.summary, /15 of 21/);
});

test('ready only when return, Sharpe, drawdown and reliability all pass', () => {
  const good = goLiveCheck(reports(25, wobble(0.2, 0.5), wobble(0.05, 0.6)));
  assert.equal(good.status, 'ready', good.summary);
  assert.equal(good.days, 21);
  assert.ok(good.checks.every(c => c.pass));
  assert.ok(Number.isFinite(good.excessT));
  const worse = goLiveCheck(reports(21, wobble(0.0, 0.5), wobble(0.1, 0.6)));
  assert.equal(worse.status, 'not ready');
  assert.match(worse.summary, /return beats the s&p 500/);
  const flaky = goLiveCheck(reports(21, wobble(0.2, 0.5), wobble(0.05, 0.6), (k) => (k < 5 ? { fills: 1, rejected: 1 } : {})));
  assert.equal(flaky.checks.find(c => c.id === 'orders').pass, false);
  const errs = goLiveCheck(reports(21, wobble(0.2, 0.5), wobble(0.05, 0.6)), { recent: [{ phase: 'error', at: '2026-12-30T15:00:00Z' }, { phase: 'error', at: '2026-12-29T15:00:00Z' }] });
  assert.equal(errs.checks.find(c => c.id === 'errors').pass, false);
  const gappy = reports(30, wobble(0.2, 0.5), wobble(0.05, 0.6)).filter((_, k) => k % 7 !== 3);
  assert.equal(goLiveCheck(gappy).checks.find(c => c.id === 'missed').pass, false);
  assert.equal(goLiveCheck([], { env: 'live' }).status, 'live');
});

test('live money can start small: SHOAL_LIVE_CAPITAL caps the sizing equity, live only', () => {
  const live = serverConfig({ ALPACA_ENV: 'live', SHOAL_LIVE_CAPITAL: '1000' });
  assert.equal(sizingEquity(50000, live), 1000);
  assert.equal(sizingEquity(800, live), 800);
  assert.equal(sizingEquity(50000, serverConfig({ SHOAL_LIVE_CAPITAL: '1000' })), 50000); // paper: no cap
  assert.equal(sizingEquity(50000, serverConfig({ ALPACA_ENV: 'live' })), 50000);
});

test('the engine notifies once when the check starts passing, and again if it stops', async () => {
  const mem = {}, sent = [];
  const store = { get: async (k) => (k in mem ? JSON.parse(JSON.stringify(mem[k])) : null), put: async (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); } };
  mem['state.json'] = { reports: reports(21, wobble(0.2, 0.5), wobble(0.05, 0.6), () => ({}), '2026-11-30') };
  let today = '';
  const st = { open: true, equity: 100000 };
  const session = {
    async req(p) { return p === '/v2/clock' ? { status: 200, body: { is_open: st.open } } : { status: 404, body: {} }; },
    async account() { return { status: 200, body: { equity: String(st.equity), cash: '0', buying_power: '0' } }; },
    async positions() { return { status: 200, body: [] }; },
    async bars() { return { status: 200, body: { bars: { SPY: [{ t: '2026-11-01T05:00:00Z', c: 600 }, { t: today + 'T05:00:00Z', c: 600.6 }] } } }; }, // SPY +0.1% each day
  };
  const day = async (date, eqClose) => {
    const ny = (t) => new Date(`${date}T${t}:00-05:00`);
    today = date;
    st.open = true; st.equity = 100000;
    await engineTick({ session, store, cfg: {}, strategy: async () => ({ ok: true, picks: [], sells: [], buys: [], waiting: [], orders: [] }), learn: null, send: async (m) => { sent.push(m); return { sent: true }; }, now: ny('09:46') });
    st.open = false; st.equity = eqClose;
    await engineTick({ session, store, cfg: {}, strategy: async () => ({ ok: true }), learn: null, send: async (m) => { sent.push(m); return { sent: true }; }, now: ny('16:05') });
  };
  await day('2026-12-01', 100300);
  const passed = sent.filter(m => /go-live check passed/.test(m.title));
  assert.equal(passed.length, 1);
  assert.match(passed[0].text, /To go live:\n1\. Open a live Alpaca account/);
  assert.match(sent.find(m => /^Shoal 2026-12-01/.test(m.title)).text, /Go-live check: Ready/);
  await day('2026-12-02', 100400);
  assert.equal(sent.filter(m => /go-live check/.test(m.title)).length, 1); // no repeat while it keeps passing
  await day('2026-12-03', 80000); // a −20% day
  assert.equal(sent.filter(m => /no longer passes/.test(m.title)).length, 1);
  assert.equal(mem['state.json'].readiness.status, 'not ready');
});

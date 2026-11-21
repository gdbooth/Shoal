import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createStore } from '../store.js';
import { engineTick, duePhases } from '../engine.js';

// New York times on a winter (EST, UTC-5) weekday
const ny = (hhmm, date = '2026-12-01') => new Date(`${date}T${hhmm}:00-05:00`);

function fakeSession() {
  const st = { open: true, equity: 100000, orders: 0, strategyCalls: 0 };
  return {
    st,
    async req(p) { if (p === '/v2/clock') return { status: 200, body: { is_open: st.open } }; return { status: 404, body: {} }; },
    async account() { return { status: 200, body: { equity: String(st.equity), cash: '1000', buying_power: '2000' } }; },
    async positions() { return { status: 200, body: [{ symbol: 'AAPL', qty: '10', market_value: '2300', unrealized_plpc: '0.01' }] }; },
    async bars() { return { status: 200, body: { bars: { SPY: [{ t: '2026-11-30T05:00:00Z', c: 600 }, { t: '2026-12-01T05:00:00Z', c: 606 }] } } }; },
  };
}
const strategy = (s) => async () => { s.st.strategyCalls++; return { ok: true, picks: ['AAPL'], sells: [], buys: s.st.strategyCalls === 1 ? [{ sym: 'AAPL', notional: 100 }] : [], waiting: [], orders: s.st.strategyCalls === 1 ? [{ sym: 'AAPL', side: 'buy', ok: true }] : [] }; };

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoal-engine-'));
  return createStore({ SHOAL_DATA_DIR: dir });
}

test('store: put, get, list; missing keys are null', async () => {
  const s = freshStore();
  assert.equal(await s.get('nope.json'), null);
  await s.put('days/2026-12-01.json', { a: 1 });
  await s.put('days/2026-12-02.json', { a: 2 });
  assert.deepEqual(await s.get('days/2026-12-01.json'), { a: 1 });
  assert.deepEqual(await s.list('days'), ['days/2026-12-01.json', 'days/2026-12-02.json']);
});

test('what is due, by the market clock', () => {
  const st = {};
  assert.deepEqual(duePhases(st, { isOpen: true, now: ny('09:40') }).due, []);            // too soon after the open
  assert.deepEqual(duePhases(st, { isOpen: true, now: ny('09:46') }).due, ['open']);
  assert.deepEqual(duePhases(st, { isOpen: true, now: ny('10:31') }).due, ['open', 'hourly']); // a late first tick does both
  const afterOpen = { lastOpenDate: '2026-12-01' };
  assert.deepEqual(duePhases(afterOpen, { isOpen: true, now: ny('10:05') }).due, []);     // hourly starts an hour after the open
  assert.deepEqual(duePhases(afterOpen, { isOpen: true, now: ny('10:35') }).due, ['hourly']);
  assert.deepEqual(duePhases({ ...afterOpen, lastHourlyKey: '2026-12-01T10' }, { isOpen: true, now: ny('10:50') }).due, []);
  assert.deepEqual(duePhases(afterOpen, { isOpen: false, now: ny('16:05') }).due, ['close']);
  assert.deepEqual(duePhases({}, { isOpen: false, now: ny('16:05') }).due, []);            // no session today (holiday): no report
  assert.deepEqual(duePhases(afterOpen, { isOpen: false, now: ny('13:10') }).due, ['close']); // half day: closed early
  // summer time (EDT, UTC-4): the open is 13:30 UTC — still 9:30 New York
  assert.deepEqual(duePhases({}, { isOpen: true, now: new Date('2026-07-01T13:46:00Z') }).due, ['open']);
});

test('a trading day: open once, hourly once per hour, end-of-day report once', async () => {
  const store = freshStore(), s = fakeSession(), strat = strategy(s), cfg = { dailyLossPct: 5 };
  const learnCalls = [], weightsSeen = [];
  const learn = async () => { learnCalls.push(1); await store.put('learning.json', { state: { weights: { mom: 1.5 } } }); return { ok: true, added: 3, scorecard: { asOf: '2026-12-01', days: 250, agents: [{ id: 'mom', weight: 1.5, prevWeight: 1.4, status: 'helping' }] } }; };
  const tick = (t) => engineTick({ session: s, store, cfg, strategy: async (...a) => { weightsSeen.push(a[2].weights); return strat(...a); }, learn, now: ny(t) });
  assert.deepEqual((await tick('09:31')).ran, []);
  assert.deepEqual((await tick('09:46')).ran, ['open']);
  assert.deepEqual((await tick('10:01')).ran, []);
  assert.deepEqual((await tick('10:31')).ran, ['hourly']);
  assert.deepEqual((await tick('10:46')).ran, []);
  s.st.equity = 99000;
  const h = await tick('11:01');
  assert.deepEqual(h.ran, ['hourly']);
  s.st.open = false;
  const c = await tick('16:01');
  assert.deepEqual(c.ran, ['close', 'learn']); // the end-of-day report, then the agent scorecard
  assert.match(c.events[1].summary, /scorecard 2026-12-01: 250 days scored; weights mom 1.40→1.50/);
  assert.deepEqual((await tick('16:16')).ran, []);
  assert.equal(learnCalls.length, 1);
  assert.deepEqual(weightsSeen, [null, null, null]); // no scorecard yet that day
  assert.equal(s.st.strategyCalls, 3); // open + two hourly follow-ups
  const state = await store.get('state.json');
  assert.equal(state.lastOpenDate, '2026-12-01');
  assert.equal(state.lastCloseDate, '2026-12-01');
  assert.equal(state.reports[0].dayReturnPct, -1);
  assert.equal(state.reports[0].spyPct, 1);
  assert.equal(state.reports[0].trades, 1);
  assert.deepEqual(state.recent.map(e => e.phase), ['learn', 'close', 'hourly', 'hourly', 'open']);
  const day = await store.get('days/2026-12-01.json');
  assert.equal(day.events.length, 5);
  assert.equal(day.scorecard.days, 250);
  assert.equal(day.report.equityClose, 99000);
});

test('daily loss limit: hourly checks make no new buys for the rest of the day', async () => {
  const store = freshStore(), s = fakeSession(), seen = [];
  const strat = async (_s, _c, o) => { seen.push(o); return { ok: true, picks: [], sells: [], buys: [], waiting: [], orders: [] }; };
  const tick = (t) => engineTick({ session: s, store, cfg: { dailyLossPct: 5 }, strategy: strat, learn: null, now: ny(t) });
  await tick('09:46');
  assert.equal(seen[0].phase, 'open');
  assert.equal(seen[0].blockBuys, undefined);
  s.st.equity = 94000;
  const h = await tick('10:31');
  assert.match(h.events[0].summary, /no new buys: daily loss limit \(-6\.0%\)/);
  assert.equal(seen[1].phase, 'hourly');
  assert.match(seen[1].blockBuys, /daily loss limit/);
});

test('hourly guardian: market falling hard blocks buys; troubled holdings flagged; stuck orders cancelled; catastrophe stop optional', async () => {
  const store = freshStore(), s = fakeSession(), seen = [], cancelled = [], closed = [];
  s.positions = async () => ({ status: 200, body: [
    { symbol: 'AAPL', qty: '10', market_value: '2300', unrealized_plpc: '0.01', change_today: '-0.002' },
    { symbol: 'XOM', qty: '5', market_value: '400', unrealized_plpc: '-0.26', change_today: '-0.09' }] });
  s.stockSnapshots = async () => ({ status: 200, body: { SPY: { latestTrade: { p: 576 }, prevDailyBar: { c: 600 } } } }); // −4%
  s.orders = async (q) => ({ status: 200, body: q.status === 'open' ? [{ id: 'o1', symbol: 'MSFT', side: 'buy', submitted_at: ny('09:46').toISOString() }] : [] });
  s.cancelOrder = async (id) => { cancelled.push(id); return { status: 200, body: {} }; };
  s.closePosition = async (sym) => { closed.push(sym); return { status: 200, body: {} }; };
  const strat = async (_s, _c, o) => { seen.push(o); return { ok: true, picks: [], sells: [], buys: [], waiting: [], orders: [] }; };
  await engineTick({ session: s, store, cfg: { dailyLossPct: 5, stopPct: 25 }, strategy: strat, learn: null, now: ny('09:46') });
  const h = await engineTick({ session: s, store, cfg: { dailyLossPct: 5, stopPct: 25 }, strategy: strat, learn: null, now: ny('10:31') });
  assert.match(seen[1].blockBuys, /market down -4\.0% today/);
  const sum = h.events[0].summary;
  assert.match(sum, /watch: XOM -9\.0% today, XOM -26\.0% from entry/);
  assert.match(sum, /stopped out: XOM/);
  assert.match(sum, /cancelled stuck orders: buy MSFT/);
  assert.deepEqual(cancelled, ['o1']);
  assert.deepEqual(closed, ['XOM']);
  // without SHOAL_STOP_PCT nothing is sold on intraday moves
  closed.length = 0;
  await engineTick({ session: s, store, cfg: { dailyLossPct: 5 }, strategy: strat, learn: null, now: ny('11:31') });
  assert.deepEqual(closed, []);
});

test('end-of-day report lists fills, rejections and orders still working', async () => {
  const store = freshStore(), s = fakeSession();
  s.orders = async (q) => ({ status: 200, body: q.status === 'open' ? [] : [
    { symbol: 'NVDA', side: 'buy', status: 'filled', filled_qty: '2', filled_avg_price: '150.5', client_order_id: 'shoal-20261201-09-open-buy-NVDA' },
    { symbol: 'AMD', side: 'buy', status: 'rejected', client_order_id: 'shoal-20261201-09-open-buy-AMD' },
    { symbol: 'XOM', side: 'sell', status: 'filled', filled_qty: '5', filled_avg_price: '80' },
    { symbol: 'ZZZ', side: 'buy', status: 'filled', filled_qty: '1', filled_avg_price: '1', client_order_id: 'manual-1' }] });
  const strat = async () => ({ ok: true, picks: [], sells: [], buys: [], waiting: [], orders: [] });
  await engineTick({ session: s, store, cfg: {}, strategy: strat, learn: null, now: ny('09:46') });
  s.st.open = false;
  const c = await engineTick({ session: s, store, cfg: {}, strategy: strat, learn: null, now: ny('16:05') });
  assert.match(c.events[0].summary, /\(2 filled, 1 rejected: AMD\)/);
  const day = await store.get('days/2026-12-01.json');
  assert.deepEqual(day.report.orders.filled.map(f => f.sym), ['NVDA', 'XOM']);
  assert.equal(day.report.orders.filled[0].value, 301);
  const st = await store.get('state.json');
  assert.equal(st.reports[0].fills, 2);
  assert.equal(st.reports[0].orders, undefined);
});

test('dry run reports what is due without doing it; a held lock skips the tick', async () => {
  const store = freshStore(), s = fakeSession(), strat = strategy(s);
  const d = await engineTick({ session: s, store, cfg: {}, strategy: strat, now: ny('09:46'), dry: true });
  assert.deepEqual([d.due, d.ran], [['open'], []]);
  assert.equal(await store.get('state.json'), null);
  await store.put('state.json', { lockUntil: ny('09:50').getTime() });
  const l = await engineTick({ session: s, store, cfg: {}, strategy: strat, now: ny('09:46') });
  assert.equal(l.skipped, 'another tick is running');
  assert.equal(s.st.strategyCalls, 0);
});

test('a failing strategy is recorded and the lock released', async () => {
  const store = freshStore(), s = fakeSession();
  const r = await engineTick({ session: s, store, cfg: {}, strategy: async () => { throw new Error('boom'); }, now: ny('09:46') });
  assert.equal(r.ok, false);
  const state = await store.get('state.json');
  assert.equal(state.lockUntil, 0);
  assert.equal(state.recent[0].phase, 'error');
});

test('the next day trades with the learned weights; a failing scorecard never fails the close', async () => {
  const store = freshStore(), s = fakeSession(), seen = [];
  await store.put('learning.json', { state: { weights: { mom: 1.3, rev: 0.7 } } });
  const strat = async (_s, _c, o) => { seen.push(o.weights); return { ok: true, picks: [], sells: [], buys: [], waiting: [], orders: [] }; };
  await engineTick({ session: s, store, cfg: {}, strategy: strat, learn: async () => { throw new Error('no bars'); }, now: ny('09:46') });
  assert.deepEqual(seen[0], { mom: 1.3, rev: 0.7 });
  s.st.open = false;
  const c = await engineTick({ session: s, store, cfg: {}, strategy: strat, learn: async () => { throw new Error('no bars'); }, now: ny('16:05') });
  assert.equal(c.ok, true);
  assert.deepEqual(c.ran, ['close', 'learn']);
  assert.match(c.events[1].summary, /scorecard failed: no bars/);
  assert.equal((await store.get('state.json')).lastCloseDate, '2026-12-01');
});

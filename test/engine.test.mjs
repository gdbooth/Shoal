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

test('daily loss limit: hourly checks stop trading for the day', async () => {
  const store = freshStore(), s = fakeSession(), strat = strategy(s);
  const tick = (t) => engineTick({ session: s, store, cfg: { dailyLossPct: 5 }, strategy: strat, now: ny(t) });
  await tick('09:46');
  s.st.equity = 94000;
  const h = await tick('10:31');
  assert.match(h.events[0].summary, /daily loss limit/);
  assert.equal(s.st.strategyCalls, 1);
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

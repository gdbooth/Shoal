// The live 9-agent team plan (trader.js teamPlan / runTeamLive) on fictional bars.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import vm from 'vm';
import { teamPlan, runTeamLive, serverConfig, strategyFor, runTilt, learnFromBroker, learnedWeights, scorecardSummary, guardCheck, clientId } from '../trader.js';

const box = {};
for (const f of ['watchlist.js', 'signals.js']) vm.runInNewContext(fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8'), box);
const S = box.ShoalSignals, W = box.ShoalWatchlist;
const SYMS = W.DEFAULT.slice(0, 12);
const SECT = Object.fromEntries(W.CATALOG.map(r => [r[0], r[2]]));
const NOW = new Date('2026-11-20T15:00:00Z'); // a Friday, market open in New York

// fictional daily bars as Alpaca returns them, the last one being today's unfinished bar
function alpacaBars(n = 420, seed = 7) {
  const cols = S.synthUniverseBars(SYMS, SECT, seed, n);
  const days = [];
  for (let d = new Date('2026-11-20T00:00:00Z'); days.length < n; d = new Date(d - 864e5)) if (d.getUTCDay() % 6) days.unshift(d.toISOString().slice(0, 10));
  return Object.fromEntries(SYMS.map(s => [s, days.map((t, i) => ({ t: t + 'T05:00:00Z', o: cols[s].o[i], h: cols[s].h[i], l: cols[s].l[i], c: cols[s].c[i], v: cols[s].v[i] }))]));
}

test('team plan: votes from all 9 agents on every stock, decided on completed bars only', () => {
  const bars = alpacaBars();
  const p = teamPlan(bars, { held: [], watchlist: SYMS, topK: 5, now: NOW });
  assert.equal(p.asOf, '2026-11-19'); // today's unfinished bar is ignored
  assert.equal(p.decisions.length, SYMS.length);
  for (const d of p.decisions) {
    assert.deepEqual(Object.keys(d.votes).sort(), [...S.AGENT_IDS].sort());
    assert.ok(['BUY', 'WAIT'].includes(d.action));
  }
  assert.ok(p.wanted.length <= 5);
  for (const s of p.wanted) assert.equal(p.decisions.find(d => d.sym === s).action, 'BUY');
  // changing today's bar changes nothing
  const b2 = alpacaBars();
  for (const s of SYMS) b2[s][b2[s].length - 1].c *= 1.5;
  assert.deepEqual(teamPlan(b2, { held: [], watchlist: SYMS, topK: 5, now: NOW }).decisions, p.decisions);
});

test('team plan: holdings get HOLD or SELL, and anything off the watchlist is sold', () => {
  const bars = alpacaBars();
  const held = [SYMS[0], SYMS[1]];
  const p = teamPlan(bars, { held, watchlist: SYMS.slice(1), topK: 5, now: NOW });
  assert.ok(p.sells.includes(SYMS[0]));
  assert.equal(p.sellWhy[SYMS[0]], 'not on the watchlist');
  const d1 = p.decisions.find(d => d.sym === SYMS[1]);
  assert.ok(['HOLD', 'SELL'].includes(d1.action));
  assert.ok(!p.wanted.includes(SYMS[1]));
});

test('live team run: dry run places no orders; buys use only cash and at most topK positions', async () => {
  const bars = alpacaBars(), placed = [];
  const session = {
    req: async () => ({ status: 200, body: { is_open: true } }),
    account: async () => ({ status: 200, body: { equity: '100000', cash: '100000', buying_power: '100000' } }),
    positions: async () => ({ status: 200, body: [] }),
    bars: async () => ({ status: 200, body: { bars } }),
    placeOrder: async (o) => { placed.push(o); return { status: 200, body: {} }; },
    closePosition: async () => ({ status: 200, body: {} }),
  };
  const cfg = { watchlist: SYMS, topK: 4, investFraction: 0.9 };
  const dry = await runTeamLive(session, cfg, { dry: true, now: NOW });
  assert.equal(dry.ok, true); assert.equal(placed.length, 0);
  assert.equal(dry.strategy, 'team');
  const r = await runTeamLive(session, cfg, { now: NOW });
  assert.equal(placed.length, r.buys.length);
  assert.ok(r.buys.length <= 4);
  assert.ok(r.buys.reduce((a, b) => a + b.notional, 0) <= 100000 * 0.9 + 1);
});

test('strategy selection: the team by default, Rank & tilt with SHOAL_STRATEGY=tilt', () => {
  assert.equal(serverConfig({}).strategy, 'team');
  assert.equal(strategyFor(serverConfig({})), runTeamLive);
  assert.equal(strategyFor(serverConfig({ SHOAL_STRATEGY: 'tilt' })), runTilt);
});

test('learning from broker history: builds the scorecard, saves the weights the team then uses', async () => {
  const bars = alpacaBars(560, 11), mem = {};
  const store = { get: async (k) => mem[k] ?? null, put: async (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); } };
  const session = { bars: async () => ({ status: 200, body: { bars } }) };
  const r = await learnFromBroker(session, { watchlist: SYMS }, store, { now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.scorecard.agents.length, 7);
  assert.ok(r.added > 100);
  const w = await learnedWeights(store);
  assert.deepEqual(Object.keys(w).sort(), [...S.PICKERS].sort());
  assert.match(scorecardSummary(r.scorecard), /scorecard 2026-11-20: \d+ days scored/);
  // running again the same day adds nothing and keeps the weights
  const r2 = await learnFromBroker(session, { watchlist: SYMS }, store, { now: NOW });
  assert.equal(r2.added, 0);
  assert.deepEqual(await learnedWeights(store), w);
  // the team plan accepts the weights
  const p = teamPlan(bars, { held: [], watchlist: SYMS, topK: 5, now: NOW, weights: w });
  assert.equal(p.decisions.length, SYMS.length);
  // too little history is reported, not guessed
  const short = await learnFromBroker({ bars: async () => ({ status: 200, body: { bars: alpacaBars(200) } }) }, { watchlist: SYMS }, { get: async () => null, put: async () => {} }, { now: NOW });
  assert.equal(short.ok, false);
});

test('orders: never a second order for a stock with one still working; pending buys count as spent; buys can be blocked', async () => {
  const bars = alpacaBars(420, 11), placed = []; // a fictional day on which the team wants to buy
  const mk = (open) => ({
    req: async () => ({ status: 200, body: { is_open: true } }),
    account: async () => ({ status: 200, body: { equity: '100000', cash: '100000', buying_power: '100000' } }),
    positions: async () => ({ status: 200, body: [] }),
    orders: async () => ({ status: 200, body: open }),
    bars: async () => ({ status: 200, body: { bars } }),
    placeOrder: async (o) => { placed.push(o); return { status: 200, body: { id: 'x' } }; },
    closePosition: async () => ({ status: 200, body: {} }),
  });
  const cfg = { watchlist: SYMS, topK: 4, investFraction: 0.9 };
  const free = await runTeamLive(mk([]), cfg, { dry: true, now: NOW });
  assert.ok(free.buys.length >= 2);
  const first = free.buys[0].sym;
  const r = await runTeamLive(mk([{ symbol: first, side: 'buy', notional: '95000' }]), cfg, { now: NOW, phase: 'hourly' });
  assert.ok(!r.buys.some(b => b.sym === first));
  assert.ok(r.buys.reduce((a, b) => a + b.notional, 0) <= 5000 + 1); // 100k cash − 95k already pending
  assert.deepEqual(r.pending, [`buy ${first}`]);
  for (const o of placed) assert.match(o.client_order_id, /^shoal-20261120-10-hourly-buy-/);
  placed.length = 0;
  const b = await runTeamLive(mk([]), cfg, { now: NOW, blockBuys: 'market down -4.0% today' });
  assert.equal(b.buys.length, 0); assert.equal(placed.length, 0);
  assert.equal(b.blockBuys, 'market down -4.0% today');
});

test('guardian rules: daily loss beats market drop; flags; stop only when configured', () => {
  const pos = [{ symbol: 'A', change_today: '-0.10', unrealized_plpc: '-0.2' }, { symbol: 'B', change_today: '0.01', unrealized_plpc: '0.05' }];
  const g = guardCheck({ positions: pos, equity: 94000, openEquity: 100000, spyDayPct: -4, cfg: { dailyLossPct: 5 } });
  assert.match(g.blockBuys, /daily loss/);
  assert.deepEqual(g.flags, ['A -10.0% today', 'A -20.0% from entry']);
  assert.deepEqual(g.stops, []);
  assert.deepEqual(guardCheck({ positions: pos, equity: 1, openEquity: 1, cfg: { stopPct: 15 } }).stops, ['A']);
  assert.equal(guardCheck({ positions: [], equity: 100, openEquity: 100, spyDayPct: -1 }).blockBuys, null);
  assert.equal(clientId(NOW, 'open', 'buy', 'AAPL'), 'shoal-20261120-10-open-buy-AAPL');
});

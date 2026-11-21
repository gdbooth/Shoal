// The live 9-agent team plan (trader.js teamPlan / runTeamLive) on fictional bars.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import vm from 'vm';
import { teamPlan, runTeamLive, serverConfig, strategyFor, runTilt } from '../trader.js';

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

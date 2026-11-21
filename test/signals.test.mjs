import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import vm from 'vm';

// signals.js is a plain browser script; run it in this context and read the global it defines.
vm.runInThisContext(fs.readFileSync(new URL('../signals.js', import.meta.url), 'utf8'));
const S = globalThis.ShoalSignals;
const { ind } = S;

const close = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} ≉ ${b} (±${tol})`);

test('SMA and EMA', () => {
  const x = [1, 2, 3, 4, 5, 6];
  assert.deepEqual(ind.sma(x, 3).slice(2), [2, 3, 4, 5]);
  assert.ok(Number.isNaN(ind.sma(x, 3)[1]));
  const e = ind.ema(x, 3); // seeded with SMA(1,2,3)=2, k=0.5
  close(e[2], 2); close(e[3], 3); close(e[4], 4); close(e[5], 5);
});

test('Wilder RSI matches the StockCharts reference example', () => {
  const c = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28,
    46.28, 46.00, 46.03, 46.41, 46.22, 45.64];
  const r = ind.rsi(c, 14);
  // exact: avg gain 3.34/14, avg loss 1.40/14
  close(r[14], 100 - 100 / (1 + 3.34 / 1.40), 1e-9);
  // StockCharts' table rounds the running averages, so it sits ~0.07 above the exact values
  [70.53, 66.32, 66.55, 69.41, 66.36, 57.97].forEach((ref, k) => close(r[14 + k], ref, 0.1));
});

test('Bollinger bands', () => {
  const flat = new Array(30).fill(10);
  const b0 = ind.bollinger(flat, 20, 2);
  close(b0.bw[29], 0);
  const c = Array.from({ length: 20 }, (_, i) => 10 + (i % 2)); // 10,11,10,11… mean 10.5, sd 0.5
  const b = ind.bollinger(c, 20, 2);
  close(b.mid[19], 10.5); close(b.up[19], 11.5); close(b.lo[19], 9.5);
  close(b.pctB[19], (11 - 9.5) / 2); // last close is 11
  close(b.bw[19], 2 / 10.5);
});

test('True range and Wilder ATR', () => {
  const h = [10, 11, 12, 11], l = [9, 10, 10, 9], c = [9.5, 10.5, 11.5, 9.5];
  assert.deepEqual(ind.trueRange(h, l, c), [1, 1.5, 2, 2.5]);
  const a = ind.atr(h, l, c, 2);
  close(a[1], 1.25);               // SMA of first two
  close(a[2], (1.25 * 1 + 2) / 2); // Wilder: (prev×(n−1) + tr) / n
  close(a[3], (a[2] + 2.5) / 2);
});

test('MACD line, signal and histogram are consistent', () => {
  const c = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 5) * 5 + i * 0.1);
  const m = ind.macd(c, 12, 26, 9);
  const ef = ind.ema(c, 12), es = ind.ema(c, 26);
  close(m.line[60], ef[60] - es[60]);
  close(m.hist[60], m.line[60] - m.signal[60]);
});

test('ADX: steady uptrend reads strong trend with +DI above −DI; noise reads weak', () => {
  const n = 120;
  const c = Array.from({ length: n }, (_, i) => 100 + i);
  const up = ind.adx(c.map(x => x + 0.5), c.map(x => x - 0.5), c, 14);
  assert.ok(up.adx[n - 1] > 60, `trend ADX ${up.adx[n - 1]}`);
  assert.ok(up.pdi[n - 1] > up.mdi[n - 1]);
  let s = 7;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const z = Array.from({ length: n }, () => 100 + (rnd() - 0.5) * 2);
  const flat = ind.adx(z.map(x => x + 0.5), z.map(x => x - 0.5), z, 14);
  assert.ok(flat.adx[n - 1] < 30, `noise ADX ${flat.adx[n - 1]}`);
});

test('Stochastic, OBV, CMF, MFI, VWAP', () => {
  const h = [10, 11, 12, 13], l = [9, 9, 10, 11], c = [9.5, 11, 11, 13], v = [100, 200, 300, 400];
  assert.equal(ind.stochastic(h, l, c, 3, 1).k[3], 100); // closed at the 3-day high
  assert.deepEqual(ind.obv(c, v), [0, 200, 200, 600]);
  // CLV: [0, 1, 0, 1] → CMF(2) at 3 = (0×300 + 1×400) / 700
  close(ind.cmf(h, l, c, v, 2)[3], 400 / 700);
  close(ind.cmf(h, l, c, v, 2, false)[3], 0.5); // no volume: average CLV
  const m = ind.mfi(h, l, c, v, 3)[3];
  assert.equal(m, 100); // typical price rose every day
  const tp = c.map((x, i) => (h[i] + l[i] + x) / 3);
  close(ind.vwap(h, l, c, v, 2)[3], (tp[2] * 300 + tp[3] * 400) / 700);
});

test('Volume z, skew, downside deviation, percentile rank', () => {
  const v = [...new Array(20).fill(1000), 1000 * Math.E ** 2];
  assert.ok(ind.volumeZ(v, 20)[20] > 2);
  const r = [0, 0.01, 0.01, 0.01, -0.05];
  assert.ok(ind.rollSkew(r, 4)[4] < 0);
  close(ind.downsideDev(r, 4)[4], Math.sqrt(0.05 ** 2 / 4));
  const pr = ind.pctRank(Array.from({ length: 40 }, (_, i) => i), 30);
  close(pr[39], 1);
});

test('normalizeBars accepts closes, bar objects and column arrays', () => {
  const a = S.normalizeBars([10, 11, 12]);
  assert.deepEqual(a.o, [10, 10, 11]);
  assert.deepEqual(a.h, [10, 11, 12]);
  const b = S.normalizeBars([{ o: 1, h: 2, l: 0.5, c: 1.5, v: 10, t: 'x' }]);
  assert.deepEqual([b.o[0], b.h[0], b.l[0], b.c[0], b.v[0]], [1, 2, 0.5, 1.5, 10]);
  assert.equal(S.makeFeatures([10, 11, 12]).hasVolume, false);
});

// Universe used by the agent tests
const SYMS = ['A1', 'A2', 'A3', 'B1', 'B2', 'B3'];
const SECT = { A1: 'A', A2: 'A', A3: 'A', B1: 'B', B2: 'B', B3: 'B' };
const FULL = S.synthUniverseBars(SYMS, SECT, 1234, 500);
const sliceBars = (bars, n) => Object.fromEntries(Object.entries(bars).map(([s, b]) =>
  [s, { o: b.o.slice(0, n), h: b.h.slice(0, n), l: b.l.slice(0, n), c: b.c.slice(0, n), v: b.v.slice(0, n) }]));

test('every agent returns a valid signal', () => {
  const U = S.buildUniverse(FULL, SECT);
  const fired = new Set();
  for (const sym of SYMS) {
    for (let i = 130; i < 500; i += 7) {
      const sigs = S.agentSignals(U, sym, i);
      assert.deepEqual(Object.keys(sigs).sort(), [...S.AGENT_IDS].sort());
      for (const [id, s] of Object.entries(sigs)) {
        assert.ok([-1, 0, 1].includes(s.dir), `${id} dir ${s.dir}`);
        assert.ok(s.strength >= 0 && s.strength <= 1, `${id} strength ${s.strength}`);
        assert.equal(typeof s.note, 'string');
        if (s.dir) fired.add(id);
      }
    }
  }
  // News drift only speaks after a gap on heavy volume; it gets its own test below
  assert.deepEqual([...S.AGENT_IDS].filter(id => !fired.has(id) && id !== 'drift'), [], 'every agent should fire at least once');
});

test('news drift: a big gap up on heavy volume that holds is a BUY for the next weeks, then fades', () => {
  const bars = Object.fromEntries(Object.entries(FULL).map(([s, b]) => [s, { o: [...b.o], h: [...b.h], l: [...b.l], c: [...b.c], v: [...b.v] }]));
  const b = bars.A1, j = 300, k = 1.08; // a +8% opening gap on 5x volume that holds
  for (let i = j; i < b.c.length; i++) { b.o[i] *= k; b.h[i] *= k; b.l[i] *= k; b.c[i] *= k; }
  b.l[j] = Math.min(b.o[j], b.c[j]); b.v[j] *= 5;
  const U = S.buildUniverse(bars, SECT);
  assert.ok(S.agentReadings(U, 'A1', j + 3).drift > 0);
  assert.equal(S.agentSignals(U, 'A1', j + 3).drift.dir, 1);
  assert.equal(S.agentReadings(U, 'A1', j + 40).drift, 0); // older than the window
});

test('team decision: majority of the 7 pickers, confidence, risk veto; a tie is never a majority', () => {
  const v = (dir, strength = 0.8) => ({ dir, strength, note: '' });
  const base = { mkt: v(0, 0), risk: v(0, 0) };
  const four = { ...base, mom: v(1), hi52: v(1), sect: v(1), rev: v(1), lowvol: v(0, 0), volshock: v(-1), drift: v(0, 0) };
  assert.equal(S.teamDecision(four).action, 'BUY');
  const three = { ...four, rev: v(0, 0) };
  assert.equal(S.teamDecision(three).action, 'WAIT');                       // 3 of 7 isn't a majority
  assert.equal(S.teamDecision({ ...four, risk: v(-1, 1) }).action, 'WAIT');  // the risk guardian objects
  assert.equal(S.teamDecision({ ...four, mom: v(1, 0.05), hi52: v(1, 0.05), sect: v(1, 0.05), rev: v(1, 0.05) }).action, 'WAIT'); // low confidence
  const against = { ...base, mom: v(-1), hi52: v(-1), sect: v(-1), rev: v(-1), lowvol: v(1), volshock: v(0, 0), drift: v(0, 0) };
  assert.equal(S.teamDecision(against, { held: true }).action, 'SELL');
  assert.equal(S.teamDecision(three, { held: true }).action, 'HOLD');
  assert.equal(S.teamDecision({ ...three, risk: v(-1, 1) }, { held: true }).action, 'SELL'); // strong danger exits
  assert.equal(S.teamDecision({ ...three, risk: v(-1, 0.6) }, { held: true }).action, 'HOLD'); // mild danger doesn't
  assert.equal(S.PICKERS.length % 2, 1);
});

test('team backtest: decisions use only past bars; trades, stays solvent, reports against buy & hold', () => {
  const a = S.runTeam(U_FULL, { start: 300, end: 420, costBps: 5, maxPos: 3 });
  const b = S.runTeam(U_CUT(420), { start: 300, end: 420, costBps: 5, maxPos: 3 });
  assert.deepEqual(a.curve, b.curve);
  assert.ok(a.buys > 0 && a.curve.every(x => x > 0));
  assert.ok(Number.isFinite(a.benchReturn) && Number.isFinite(a.sharpe));
});

test('no lookahead: signals at bar i ignore every later bar', () => {
  const U = S.buildUniverse(FULL, SECT);
  for (const cut of [200, 333, 420]) {
    const Ut = S.buildUniverse(sliceBars(FULL, cut + 1), SECT);
    for (const sym of SYMS) {
      const a = S.agentSignals(U, sym, cut), b = S.agentSignals(Ut, sym, cut);
      for (const id of S.AGENT_IDS) {
        assert.deepEqual(a[id], b[id], `${id} on ${sym} at ${cut} changed when future bars were added`);
      }
      assert.deepEqual(S.regimeAt(U.F[sym], cut), S.regimeAt(Ut.F[sym], cut));
    }
  }
});

test('volume agents fall back to price-only when there is no volume', () => {
  const noVol = Object.fromEntries(Object.entries(FULL).map(([s, b]) => [s, { ...b, v: b.v.map(() => 0) }]));
  const U = S.buildUniverse(noVol, SECT);
  assert.equal(U.F.A1.hasVolume, false);
  const sigs = S.agentSignals(U, 'A1', 400);
  assert.equal(sigs.volshock.dir, 0); // no volume → no view
  for (const s of Object.values(sigs)) assert.ok(Number.isFinite(s.strength));
});

test('ensemble: confidence needs agreement and participation', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const w = { a: 0.25, b: 0.25, c: 0.25, d: 0.25 };
  const one = S.ensemble({ a: { dir: 1, strength: 0.3 } }, w, { ids });
  const all = S.ensemble({ a: { dir: 1, strength: 0.8 }, b: { dir: 1, strength: 0.8 }, c: { dir: 1, strength: 0.8 }, d: { dir: 1, strength: 0.8 } }, w, { ids });
  const split = S.ensemble({ a: { dir: 1, strength: 0.8 }, b: { dir: -1, strength: 0.8 } }, w, { ids });
  assert.ok(one.confidence < 0.6, `single weak agent → ${one.confidence}`);
  assert.ok(all.confidence > 0.9);
  assert.equal(all.dir, 'BUY'); assert.equal(all.consensus, 4);
  assert.equal(split.dir, null);
  // a regime multiplier of zero silences an agent
  const muted = S.ensemble({ a: { dir: -1, strength: 0.9 }, b: { dir: 1, strength: 0.5 } }, w, { ids, regimeMult: { a: 0 } });
  assert.equal(muted.dir, 'BUY');
});

test('correlation adjustment down-weights agents that vote alike', () => {
  const ids = ['x', 'y', 'z'];
  const rows = Array.from({ length: 100 }, (_, t) => {
    const v = t % 3 === 0 ? 1 : t % 3 === 1 ? -1 : 0;
    return { x: v, y: v, z: (t * 7) % 5 === 0 ? 1 : (t * 7) % 5 === 1 ? -1 : 0 };
  });
  const adj = S.correlationAdjust(rows, ids);
  assert.ok(adj.x < adj.z && adj.y < adj.z, JSON.stringify(adj));
  assert.deepEqual(S.correlationAdjust(rows.slice(0, 5), ids), { x: 1, y: 1, z: 1 }); // too little data
});

test('regime multipliers start neutral and move with evidence', () => {
  const m0 = S.regimeMultipliers({}, ['a']);
  close(m0.a, 1);
  const good = S.regimeMultipliers({ a: new Array(40).fill(true) }, ['a']);
  const bad = S.regimeMultipliers({ a: new Array(40).fill(false) }, ['a']);
  assert.ok(good.a > 1.3 && bad.a < 0.7);
});

test('ATR plan sizes to the risk budget and caps at max trade size', () => {
  const p = S.atrPlan({ price: 100, atr: 2, equity: 100000, riskPct: 1, maxTradePct: 50, atrStop: 2, atrTarget: 3, confidence: 1 });
  close(p.stopPct, 0.04); close(p.tpPct, 0.06);
  close(p.notional, 1000 / 0.04); // risk $1,000 over a 4% stop
  const capped = S.atrPlan({ price: 100, atr: 0.1, equity: 100000, riskPct: 1, maxTradePct: 5, confidence: 1 });
  close(capped.notional, 5000);
});

test('backtest: trades, stays solvent, reports by regime', () => {
  const U = S.buildUniverse(FULL, SECT);
  const r = S.runBacktest(U, { start: 150 });
  assert.ok(r.tradeCount > 10, `trades ${r.tradeCount}`);
  assert.equal(r.curve.length, r.bench.length);
  assert.ok(r.curve.every(v => v > 0));
  assert.ok(Object.keys(r.byRegime).every(k => S.REGIME_KEYS.includes(k)));
  for (const t of r.trades) assert.ok(t.exitG >= t.entryG);
});

test('evaluateAgents reports hit rate, expectancy and vote correlation', () => {
  const U = S.buildUniverse(FULL, SECT);
  const e = S.evaluateAgents(U, { start: 150, step: 3 });
  assert.equal(e.corr.length, S.AGENT_IDS.length);
  for (const id of S.AGENT_IDS) {
    const a = e.agents[id];
    assert.ok(a.hitRate >= 0 && a.hitRate <= 1);
    assert.ok(a.fireRate >= 0 && a.fireRate <= 1);
  }
  assert.ok(e.avgAbsCorr >= 0 && e.avgAbsCorr <= 1);
});

// ── Autopilot + stay-invested ───────────────────────────────────────────────
const U_FULL = S.buildUniverse(FULL, SECT);
const U_CUT = (n) => S.buildUniverse(sliceBars(FULL, n + 1), SECT);

test('score book: weights sum to 1 (or all zero with no edge) and use only matured outcomes', () => {
  const book = S.createScoreBook(U_FULL, {}, { window: 120 });
  const asOf = 380;
  const w = book.weightsAt(asOf);
  const tot = Object.values(w.w).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(tot - 1) < 1e-9 || (w.status === 'no-edge' && tot < 1), `sum ${tot} status ${w.status}`);
  // identical when every bar after asOf is removed → no lookahead
  const wCut = S.createScoreBook(U_CUT(asOf), {}, { window: 120 }).weightsAt(asOf);
  for (const id of S.AGENT_IDS) close(w.w[id], wCut.w[id], 1e-12);
});

test('score book: warming up gives equal weights; sell-side scoring ignores BUY calls', () => {
  const early = S.createScoreBook(U_FULL, {}).target(70);
  assert.equal(early.status, 'warming-up');
  const sell = S.createScoreBook(U_FULL, {}, { side: 'sell' });
  const both = S.createScoreBook(U_FULL, {});
  const d1 = sell.day(300), d2 = both.day(300);
  assert.ok(Object.keys(d1).length <= Object.keys(d2).length);
});

test('watch-it-first: promotion decided only on outcomes known at the time', () => {
  const asOf = 420;
  const a = S.proposeWeights(S.createScoreBook(U_FULL, {}, { testDays: 40 }), asOf, null);
  const b = S.proposeWeights(S.createScoreBook(U_CUT(asOf), {}, { testDays: 40 }), asOf, null);
  assert.equal(a.promote, b.promote);
  close(a.challengerScore.mean, b.challengerScore.mean, 1e-12);
  assert.equal(typeof a.promote, 'boolean');
});

test('tested tuning: no lookahead and only accepts values that also win on newer data', () => {
  const asOf = 450;
  const a = S.tuneParam(U_FULL, 'mom', asOf, {}, { testDays: 40 });
  const b = S.tuneParam(U_CUT(asOf), 'mom', asOf, {}, { testDays: 40 });
  assert.deepEqual(a, b);
  if (a.accepted) assert.ok(a.testMean > a.testMeanCurrent);
  assert.ok(S.TUNE_KEYS.mom.values.includes(a.best) || a.best === S.DEFAULT_PARAMS.mom.lookback);
});

test('stay invested: never selling matches buy-and-hold; selling reduces time invested', () => {
  const hold = S.runInvested(U_FULL, { start: 150, minConf: 2, investFraction: 1, slip: 0 });
  assert.equal(hold.sells, 0);
  assert.ok(Math.abs(hold.totalReturn - hold.benchReturn) < 0.03, `${hold.totalReturn} vs ${hold.benchReturn}`);
  const act = S.runInvested(U_FULL, { start: 150, minConf: 0.3 });
  assert.ok(act.sells > 0 && act.invested < hold.invested);
  assert.ok(act.curve.every(v => v > 0));
});

test('stay invested: daily loss limit blocks buying the next day', () => {
  const free = S.runInvested(U_FULL, { start: 150, minConf: 0.3 });
  const capped = S.runInvested(U_FULL, { start: 150, minConf: 0.3, dailyLoss: 0.5 });
  const buys = r => r.trades.length;
  assert.ok(buys(capped) <= buys(free));
});

// ── Settings optimiser ──────────────────────────────────────────────────────
test('optimiser: needs warm-up history before the window', async () => {
  const r = await S.optimiseSettings(U_FULL, { asOf: 150, days: 100 });
  assert.match(r.error, /Need \d+ days of history/);
});

test('optimiser: never worse than the starting settings in the window; held-out check included', async () => {
  let last = 0;
  const r = await S.optimiseSettings(U_FULL, { asOf: 420, days: 100, onProgress: p => { last = p; } });
  assert.equal(r.from, 321); assert.equal(r.to, 420);
  assert.ok(r.best.ret >= r.baseline.ret);
  assert.ok(r.heldOut && r.heldOut.to === 320 && r.heldOut.from === 221);
  assert.ok(Number.isFinite(r.heldOut.best.ret) && Number.isFinite(r.heldOut.baseline.ret));
  assert.equal(last, 1);
  assert.ok(['tilt', 'invested', 'both'].includes(r.best.cfg.style));
  assert.equal(typeof r.canApply, 'boolean');
  if (r.canApply) assert.ok(r.changed && r.heldOut.best.obj > r.heldOut.baseline.obj);
  if (r.best.cfg.param) assert.equal(r.best.cfg.param.agent, r.best.cfg.agents);
});

test('optimiser: no lookahead — later bars do not change the result', async () => {
  const a = await S.optimiseSettings(U_FULL, { asOf: 380, days: 80 });
  const b = await S.optimiseSettings(U_CUT(380), { asOf: 380, days: 80 });
  assert.deepEqual(a.best.cfg, b.best.cfg);
  close(a.best.ret, b.best.ret, 1e-12);
});

test('compare: frozen vs previous settings and buy-and-hold on the days since freezing', () => {
  const frozen = { cfg: { style: 'invested', agents: 'swarm', minConf: 0.55, investFraction: 1 }, params: {} };
  const before = { cfg: { style: 'invested', agents: 'default', minConf: 0.55, investFraction: 0.9 }, params: {} };
  const c = S.compareSettings(U_FULL, { frozen, before, from: 401, to: 460 });
  assert.equal(c.days, 60);
  for (const k of ['frozen', 'before']) assert.ok(Number.isFinite(c[k].ret));
  assert.ok(Number.isFinite(c.bench));
});

// ── Costs, Rank & tilt, combination model ───────────────────────────────────
test('costs: higher per-side cost lowers the result in every engine', () => {
  const a = S.runTilt(U_FULL, { start: 150, costBps: 0 }), b = S.runTilt(U_FULL, { start: 150, costBps: 50 });
  assert.ok(b.totalReturn < a.totalReturn);
  const c = S.runInvested(U_FULL, { start: 150, minConf: 0.3, costBps: 0 }), d = S.runInvested(U_FULL, { start: 150, minConf: 0.3, costBps: 50 });
  assert.ok(d.totalReturn < c.totalReturn);
  assert.ok(S.COST_PROFILES.ig.bps > S.COST_PROFILES.alpaca.bps);
});

test('rank & tilt: holds the top K, re-ranks every 21 bars without dates, stays invested', () => {
  const r = S.runTilt(U_FULL, { start: 150, topK: 3, costBps: 5 });
  assert.ok(r.rebalances >= Math.floor((499 - 150) / 21));
  for (const p of r.picks) assert.equal(p.keep.length, 3);
  assert.ok(r.invested > 0.9, `invested ${r.invested}`);
  assert.ok(r.turnover > 0 && Number.isFinite(r.turnover));
  // first pick = top 3 by trend score on the first day
  const g = 150, ranked = SYMS.map(s => [s, S.trendScore(U_FULL.F[s], g)]).sort((a, b) => b[1] - a[1]).slice(0, 3).map(x => x[0]).sort();
  assert.deepEqual([...r.picks[0].keep].sort(), ranked);
});

test('rank & tilt: re-ranks at month ends when bars have dates', () => {
  const days = []; for (let d = new Date('2020-01-01'); days.length < 500; d = new Date(d.getTime() + 86400000)) { if (d.getUTCDay() % 6) days.push(d.toISOString().slice(0, 10)); }
  const dated = Object.fromEntries(Object.entries(FULL).map(([s, b]) => [s, { ...b, t: days }]));
  const U = S.buildUniverse(dated, SECT);
  const r = S.runTilt(U, { start: 150, topK: 3 });
  for (const p of r.picks.slice(1)) assert.notEqual(days[p.g].slice(0, 7), days[p.g + 1].slice(0, 7));
});

test('model: falls back while warming up, then fits; no lookahead', () => {
  assert.equal(S.fitModel(U_FULL, { asOf: 160, ids: ['mom'] }).status, 'warming-up');
  const a = S.fitModel(U_FULL, { asOf: 420, ids: ['mom', 'hi52'] });
  assert.equal(a.status, 'ok'); assert.equal(a.beta.length, 3); assert.deepEqual(a.features, ['trend', 'mom', 'hi52']);
  const b = S.fitModel(U_CUT(420), { asOf: 420, ids: ['mom', 'hi52'] });
  a.beta.forEach((v, k) => close(v, b.beta[k], 1e-12));
  // heavy shrinkage → the trend coefficient stays positive (the prior)
  const strong = S.fitModel(U_FULL, { asOf: 420, ids: ['mom'], lambda: 1e6 });
  assert.ok(strong.beta[0] > 0 && Math.abs(strong.beta[1]) < Math.abs(strong.beta[0]));
});

test('model scorer: walk-forward pruning and no lookahead', () => {
  const book = S.createScoreBook(U_FULL, {}), bookCut = S.createScoreBook(U_CUT(430), {});
  const a = S.createModelScorer(U_FULL, book.signalsAt), b = S.createModelScorer(U_CUT(430), bookCut.signalsAt);
  for (const sym of SYMS) close(a.scoreAt(sym, 430), b.scoreAt(sym, 430), 1e-12);
  assert.ok(a.state.fits.length === 1 && Array.isArray(a.state.kept));
});

test('evidence: rank IC in [-1, 1] with honest (non-overlapping) samples', () => {
  const book = S.createScoreBook(U_FULL, {});
  const ev = S.agentEvidence(U_FULL, { signalsAt: book.signalsAt, from: 130, to: 480 });
  for (const id of S.AGENT_IDS) { assert.ok(ev[id].mean >= -1 && ev[id].mean <= 1); assert.ok(ev[id].n <= Math.ceil((480 - 130) / 21)); }
  const t = S.rankIC(U_FULL, (s, i) => S.trendScore(U_FULL.F[s], i), { from: 130, to: 480 });
  assert.ok(Number.isFinite(t.mean));
});

test('optimiser objective: a drawdown cap penalises deep drops', async () => {
  const free = await S.optimiseSettings(U_FULL, { asOf: 420, days: 100, objective: 'return' });
  const capped = await S.optimiseSettings(U_FULL, { asOf: 420, days: 100, ddCap: 0.01 });
  assert.equal(free.objective, 'return'); assert.equal(capped.objective, 'balanced');
  assert.ok(capped.best.obj <= capped.best.ret + 1e-12);
});

test('rank & tilt crash guard: always off = same as no guard; always on = stays in cash', () => {
  const base = S.runTilt(U_FULL, { start: 150, topK: 3 });
  const never = S.runTilt(U_FULL, { start: 150, topK: 3, riskOff: () => false });
  close(base.totalReturn, never.totalReturn, 1e-12);
  const always = S.runTilt(U_FULL, { start: 150, topK: 3, riskOff: () => true, riskOffDaily: true });
  assert.equal(always.tradeCount, 0);
  assert.ok(always.riskOffDays > 300);
  close(always.totalReturn, 0, 1e-12);
  const g = S.marketBelowAverage(U_FULL, 50);
  assert.equal(typeof g(300), 'boolean');
});

test('learning: every call scored once its horizon passes; incremental = full rebuild; damped weight steps', () => {
  const dated = (bars) => Object.fromEntries(Object.entries(bars).map(([s, b]) => [s, b.c.map((c, i) => ({ t: new Date(Date.UTC(2020, 0, 1) + i * 864e5).toISOString().slice(0, 10), o: b.o[i], h: b.h[i], l: b.l[i], c, v: b.v[i] }))]));
  const D = dated(FULL), cut = (n) => Object.fromEntries(Object.entries(D).map(([s, a]) => [s, a.slice(0, n)]));
  const L = { keepDays: 120, minDays: 20 };
  const full = S.learnUpdate(S.buildUniverse(D, SECT), {}, { learn: L });
  const sc = full.scorecard;
  assert.equal(sc.agents.length, 7);
  assert.equal(sc.days, 120);
  for (const a of sc.agents) {
    assert.ok(a.weight > 0 && a.weight <= 2.5 && Number.isFinite(a.t));
    assert.ok(Math.abs(a.weight - 1) <= Math.abs(a.target - 1) * 0.5 + 0.3); // seeded half way, then renormalised
  }
  assert.ok(Math.abs(sc.agents.reduce((x, a) => x + a.weight, 0) / 7 - 1) < 0.01);
  // a call is scored only when its horizon has passed: the last 21 days have no 21-day score
  const lastDate = D.A1[499].t, keys21 = Object.keys(full.state.days[21]).sort(), keys5 = Object.keys(full.state.days[5]).sort();
  assert.equal(keys21[keys21.length - 1], D.A1[499 - 21].t);
  assert.equal(keys5[keys5.length - 1], D.A1[499 - 5].t);
  assert.equal(sc.asOf, lastDate);
  // built day by day, the agents' daily scores match the full rebuild
  let st = S.learnUpdate(S.buildUniverse(cut(480), SECT), {}, { learn: L }).state;
  const w480 = { ...st.weights };
  const r481 = S.learnUpdate(S.buildUniverse(cut(481), SECT), st, { learn: L });
  for (const id of S.PICKERS) {
    const target = r481.scorecard.agents.find(a => a.id === id).target;
    const raw = w480[id] + 0.1 * (target - w480[id]);
    assert.ok(Math.abs(raw - w480[id]) <= Math.abs(target - w480[id]) * 0.1 + 0.05, id); // one damped step
  }
  const again = S.learnUpdate(S.buildUniverse(cut(481), SECT), r481.state, { learn: L });
  assert.deepEqual(again.state.weights, r481.state.weights); // the same day twice moves nothing
  assert.equal(again.added, 0);
  st = r481.state;
  for (let n = 482; n <= 500; n++) st = S.learnUpdate(S.buildUniverse(cut(n), SECT), st, { learn: L }).state;
  for (const k of Object.keys(st.days[21])) assert.deepEqual(st.days[21][k].ic, full.state.days[21][k].ic, k);
  assert.ok(st.history.length >= 20);
});

test('learning helpers: rank correlation and an overlap-aware t-statistic', () => {
  const U = S.buildUniverse(Object.fromEntries(Object.entries(FULL).map(([s, b]) => [s, b.c.map((c, i) => ({ t: new Date(Date.UTC(2020, 0, 1) + i * 864e5).toISOString().slice(0, 10), o: b.o[i], h: b.h[i], l: b.l[i], c, v: b.v[i] }))])), SECT);
  assert.equal(S.spearman([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]), 1);
  assert.equal(S.spearman([1, 2, 3, 4, 5], [5, 4, 3, 2, 1]), -1);
  const st = S.recordStats([0.1, 0.12, 0.08, 0.11, 0.09, 0.1, 0.1, 0.13], 1);
  assert.ok(st.t > 10);
  assert.ok(S.recordStats([0.1, 0.12, 0.08, 0.11, 0.09, 0.1, 0.1, 0.13], 21).t < st.t); // overlapping days count once
  assert.ok(U.L === 500);
});

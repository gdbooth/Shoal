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
  assert.deepEqual([...S.AGENT_IDS].filter(id => !fired.has(id)), [], 'every agent should fire at least once');
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
  assert.match(sigs.flow.note, /no volume|CMF|close location/);
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
  const a = S.tuneParam(U_FULL, 'earn', asOf, {}, { testDays: 40 });
  const b = S.tuneParam(U_CUT(asOf), 'earn', asOf, {}, { testDays: 40 });
  assert.deepEqual(a, b);
  if (a.accepted) assert.ok(a.testMean > a.testMeanCurrent);
  assert.ok(S.TUNE_KEYS.earn.values.includes(a.best) || a.best === S.DEFAULT_PARAMS.earn.lookback);
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

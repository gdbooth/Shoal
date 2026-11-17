import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import vm from 'vm';

vm.runInThisContext(fs.readFileSync(new URL('../intraday.js', import.meta.url), 'utf8'));
const I = globalThis.ShoalIntraday;

test('New York session times, both sides of the March clock change', () => {
  assert.deepEqual(I.etParts(Date.parse('2026-01-15T14:30:00Z')), { date: '2026-01-15', min: 570 });
  assert.deepEqual(I.etParts(Date.parse('2026-03-09T13:30:00Z')), { date: '2026-03-09', min: 570 });
  assert.deepEqual(I.etParts(Date.parse('2026-11-16T20:55:00Z')), { date: '2026-11-16', min: 955 });
});

test('regular session only: 78 five-minute slots, pre-market bars dropped', () => {
  const bars = I.synthIntraday({ days: 5, endDate: '2026-11-13' });
  const P = I.prepare(bars);
  assert.equal(P.slots, 78);
  assert.equal(P.market, 'SPY');
  assert.equal(P.dates.length, 5);
  for (const sym of P.syms) for (const D of P.S[sym]) assert.equal(D.real.reduce((a, b) => a + b, 0), 78);
});

test('no lookahead: changing later bars does not change earlier scores', () => {
  const bars = I.synthIntraday({ days: 25, endDate: '2026-11-13', seed: 3 });
  const A = I.computeScores(I.prepare(bars));
  // scramble everything after 13:00 New York on the last-but-two day, and all later days
  const cut = Date.parse('2026-11-11T18:00:00Z');
  const altered = Object.fromEntries(Object.entries(bars).map(([s, b]) => [s, b.map(x => (Date.parse(x.t) >= cut ? { ...x, c: x.c * 1.5, h: x.h * 1.6, v: x.v * 9 } : x))]));
  const B = I.computeScores(I.prepare(altered));
  const P = I.prepare(bars), d = P.S.AAA.findIndex(D => D.date === '2026-11-11');
  for (const id of I.IDS.filter(x => x !== 'tod')) for (let k = 0; k < 42; k++) {
    const a = A.AAA[d][id][k], b = B.AAA[d][id][k];
    assert.ok((Number.isNaN(a) && Number.isNaN(b)) || Math.abs(a - b) < 1e-12, `${id} at bar ${k}`);
  }
});

test('a random market is not a GO; costs show up as the loss per signal', () => {
  const R = I.evaluate(I.prepare(I.synthIntraday({ days: 50, seed: 11, endDate: '2026-11-13' })), { H: 6, costBps: 5 });
  assert.notEqual(R.verdict.level, 'go');
  const strong = R.agents.filter(a => Math.abs(a.test.icT) >= 3);
  assert.equal(strong.length, 0, strong.map(a => a.id).join());
});

test('a planted 30-minute momentum effect is found, by the right agent, on unseen days', () => {
  const R = I.evaluate(I.prepare(I.synthIntraday({ days: 50, seed: 11, plant: 0.15, endDate: '2026-11-13' })), { H: 6, costBps: 5 });
  const mom = R.agents.find(a => a.id === 'mom');
  assert.ok(mom.test.ic > 0.2 && mom.test.icT > 5);
  assert.equal(R.verdict.level, 'go');
  assert.ok(R.backtest.avgNetBp > 0 && R.backtest.trades > 100);
  const top = R.combined.weights.slice().sort((a, b) => b.impactBp - a.impactBp)[0];
  assert.ok(['mom', 'pressure', 'rsi', 'vwap'].includes(top.id), top.id);
  // higher costs eat the edge per trade
  const R2 = I.evaluate(I.prepare(I.synthIntraday({ days: 50, seed: 11, plant: 0.15, endDate: '2026-11-13' })), { H: 6, costBps: 15 });
  assert.ok(R2.agents.find(a => a.id === 'mom').test.netBp < mom.test.netBp);
});

test('open → close test: a planted first-half-hour → last-half-hour effect is found; none in noise', () => {
  const mk = (strength) => {
    const bars = I.synthIntraday({ days: 120, seed: 4, endDate: '2026-11-13' });
    if (strength) { // make SPY's last half hour follow its first half hour
      const byDay = new Map();
      for (const b of bars.SPY) { const { date, min } = I.etParts(Date.parse(b.t)); if (min >= 570 && min < 960) (byDay.get(date) || byDay.set(date, []).get(date)).push(b); }
      let prevClose = null;
      for (const day of byDay.values()) {
        if (prevClose) { const first = day[5].c / prevClose - 1; const shift = 1 + strength * first;
          for (let k = 72; k < 78; k++) { day[k].o *= shift; day[k].h *= shift; day[k].l *= shift; day[k].c *= shift; } }
        prevClose = day[77].c;
      }
    }
    return I.openCloseTest(I.prepare(bars), { costBps: 1 });
  };
  const planted = mk(0.8), noise = mk(0);
  assert.ok(planted.corr > 0.2 && planted.corrT > 2, String(planted.corr));
  assert.equal(planted.verdict.level, 'go');
  assert.ok(Math.abs(noise.corrT) < 3);
});

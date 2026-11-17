import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import vm from 'vm';

vm.runInThisContext(fs.readFileSync(new URL('../signals.js', import.meta.url), 'utf8'));
vm.runInThisContext(fs.readFileSync(new URL('../swing.js', import.meta.url), 'utf8'));
const S = globalThis.ShoalSignals, W = globalThis.ShoalSwing;
const syms = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10'];
const U = S.buildUniverse(S.synthUniverseBars(syms, {}, 9, 900), {});
const H = 5;
let s = 3; const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
const noise = new Map();
// agents: 'noise' is random; 'peek' knows a little of the next H days (only usable if fitted honestly on
// past outcomes, since its link to returns is stable); 'past' is last week's return
const signalsAt = (sym, i) => {
  const F = U.F[sym];
  const k = sym + i; if (!noise.has(k)) noise.set(k, rnd() * 2 - 1);
  const fwd = i + H < F.n ? F.c[i + H] / F.c[i] - 1 : 0;
  return { noise: { dir: Math.sign(noise.get(k)) || 1, strength: Math.abs(noise.get(k)) },
           peek: { dir: Math.sign(fwd + (rnd() - 0.5) * 0.08) || 1, strength: 0.6 },
           past: { dir: Math.sign(F.c[i] / F.c[Math.max(0, i - 5)] - 1) || 1, strength: 0.5 } };
};

test('pure noise agents: no reliable picking, not a GO', async () => {
  const R = await W.evaluateSwing(U, { signalsAt: (sym, i) => ({ noise: signalsAt(sym, i).noise }), ids: ['noise'], trendId: 'noise', H, costBps: 5 });
  assert.ok(Math.abs(R.combined.icT) < 3, String(R.combined.icT));
  assert.notEqual(R.verdict.level, 'go');
});

test('an agent with real information is found and weighted most; decisions explain themselves', async () => {
  const R = await W.evaluateSwing(U, { signalsAt, ids: ['noise', 'peek', 'past'], trendId: 'past', H, costBps: 5 });
  assert.ok(R.combined.ic > 0.1 && R.combined.icT > 3, `${R.combined.ic} ${R.combined.icT}`);
  const top = R.weights.slice().sort((a, b) => b.impactBp - a.impactBp)[0];
  assert.equal(top.id, 'peek');
  assert.ok(R.model.avgNetBp > 0 && R.model.trades > 30);
  assert.ok(R.decisions.length > 0 && R.decisions.every(d => d.p >= 0 && d.p <= 1 && Array.isArray(d.contrib)));
  // walk-forward: nothing predicted before the first fit day
  assert.ok(R.start >= 250);
});

test('walk-forward fits only use outcomes known before the fit day', async () => {
  // an agent that is right on training days but whose sign flips after day 600: a leaking fit would
  // keep "knowing" the flip; an honest one keeps trading the old way and loses on the later days
  const flip = (sym, i) => { const sg = signalsAt(sym, i).peek; return { flip: { dir: (i + U.off[sym] >= 600 ? -1 : 1) * sg.dir, strength: 0.6 } }; };
  const R = await W.evaluateSwing(U, { signalsAt: flip, ids: ['flip'], trendId: 'flip', H, costBps: 5, refit: 1000, start: 300, window: 750 });
  assert.ok(R.combined.ic < 0.2, String(R.combined.ic)); // mixed: right before 600, wrong after
});

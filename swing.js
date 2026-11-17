// Shoal swing lab: can the 16 daily agents, working together, call a stock's move over the next 2–10
// trading days well enough to trade it after costs, and do they add anything over the trend score alone?
// Plain browser script (window.ShoalSwing); tests load it in Node through vm, with signals.js.
//
// Every day each agent scores each stock (direction × strength, −1…1). A combined model — ridge
// regression for the expected H-day return and logistic regression for the probability of a rise — is
// refitted every `refit` days on the previous `window` days whose outcomes were already known, and used
// only on the days after its fit (walk-forward). Everything reported is from those unseen days.
(function (root) {
  'use strict';
  const fin = Number.isFinite;
  const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  const tstat = (a) => { if (a.length < 3) return 0; const m = mean(a), v = a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1); return v > 0 ? m / Math.sqrt(v / a.length) : 0; };
  function pearson(x, y) {
    const n = x.length; if (n < 3) return NaN;
    let mx = 0, my = 0; for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; } mx /= n; my /= n;
    let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < n; i++) { const a = x[i] - mx, b = y[i] - my; sxy += a * b; sxx += a * a; syy += b * b; }
    return sxx > 1e-12 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN;
  }
  function solve(A, b) {
    const n = b.length, M = A.map((r, i) => [...r, b[i]]);
    for (let c = 0; c < n; c++) {
      let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      [M[c], M[p]] = [M[p], M[c]];
      if (Math.abs(M[c][c]) < 1e-12) continue;
      for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
    }
    return M.map((r, i) => (Math.abs(r[i]) < 1e-12 ? 0 : r[n] / r[i]));
  }
  const tick = () => new Promise(res => setTimeout(res, 0));

  // ridge (expected return, bp) + logistic (probability of a rise) on rows { x: [...], r }
  function fit(rows, k, { ridge = 0.05, l2 = 2e-3 } = {}) {
    const p = k + 1, n = rows.length;
    if (n < 100) return null;
    const XtX = Array.from({ length: p }, () => new Float64Array(p)), Xty = new Float64Array(p);
    for (const w of rows) { const x = w.x; for (let a = 0; a < p; a++) { const xa = a ? x[a - 1] : 1; Xty[a] += xa * w.r * 1e4; for (let b = 0; b < p; b++) XtX[a][b] += xa * (b ? x[b - 1] : 1); } }
    const beta = solve(XtX.map((r, a) => r.map((v, b) => v + (a === b && a > 0 ? ridge * n : 0))), [...Xty]);
    let wv = new Float64Array(p);
    for (let it = 0; it < 7; it++) {
      const g = new Float64Array(p), Hm = Array.from({ length: p }, () => new Float64Array(p));
      for (const row of rows) {
        const x = row.x; let z = wv[0]; for (let a = 1; a < p; a++) z += wv[a] * x[a - 1];
        const q = 1 / (1 + Math.exp(-z)), y = row.r > 0 ? 1 : 0, ww = q * (1 - q);
        for (let a = 0; a < p; a++) { const xa = a ? x[a - 1] : 1; g[a] += (q - y) * xa; for (let b = 0; b < p; b++) Hm[a][b] += ww * xa * (b ? x[b - 1] : 1); }
      }
      for (let a = 1; a < p; a++) { g[a] += l2 * n * wv[a]; Hm[a][a] += l2 * n; }
      const d = solve(Hm.map(r => [...r]), [...g]);
      wv = wv.map((v, a) => v - d[a]);
    }
    const sd = Array.from({ length: k }, (_, j) => { let s = 0, q = 0; for (const w of rows) { s += w.x[j]; q += w.x[j] ** 2; } const m = s / n; return Math.sqrt(Math.max(0, q / n - m * m)); });
    return { beta, w: [...wv], sd, n };
  }
  function predict(M, x) {
    let e = M.beta[0], z = M.w[0];
    for (let j = 0; j < x.length; j++) { e += M.beta[j + 1] * x[j]; z += M.w[j + 1] * x[j]; }
    return { e, p: 1 / (1 + Math.exp(-z)) };
  }

  // Score matrix: X[sym][g] = agent scores at the close of global day g; R[sym][g] = return from that
  // close to the close H days later (NaN if not yet known)
  async function scoreMatrix(U, { signalsAt, ids, H, onProgress }) {
    const X = {}, R = {};
    for (let s = 0; s < U.syms.length; s++) {
      const sym = U.syms[s], F = U.F[sym], off = U.off[sym];
      X[sym] = new Array(U.L).fill(null); R[sym] = new Float64Array(U.L).fill(NaN);
      for (let g = off + 60; g < U.L; g++) {
        const i = g - off, sg = signalsAt(sym, i);
        if (!sg) continue;
        X[sym][g] = ids.map(id => { const v = sg[id]; return v && v.dir ? v.dir * (fin(v.strength) ? v.strength : 0.5) : 0; });
        if (i + H < F.n) R[sym][g] = F.c[i + H] / F.c[i] - 1;
      }
      if (onProgress) onProgress((s + 1) / U.syms.length);
      await tick();
    }
    return { X, R };
  }

  // Walk-forward predictions: a model refitted every `refit` days on the previous `window` days with known
  // outcomes (labels from day g need g + H ≤ fit day − 1), used for the next `refit` days only
  async function walkForward(U, X, R, { cols, H, start, refit, window }) {
    const k = cols.length, pred = Object.fromEntries(U.syms.map(s => [s, new Array(U.L).fill(null)])), fits = [];
    const pick = (x) => cols.map(j => x[j]);
    for (let t = start; t < U.L; t += refit) {
      const rows = [];
      for (const sym of U.syms) for (let g = Math.max(0, t - H - window); g <= t - 1 - H; g++) { const x = X[sym][g], r = R[sym][g]; if (x && fin(r)) rows.push({ x: pick(x), r }); }
      const M = fit(rows, k);
      fits.push({ g: t, n: rows.length, ok: !!M });
      if (M) for (const sym of U.syms) for (let g = t; g < Math.min(U.L, t + refit); g++) { const x = X[sym][g]; if (x) pred[sym][g] = predict(M, pick(x)); }
      await tick();
    }
    return { pred, fits };
  }

  // Daily trading on the predictions: decide at a close, buy at the next open, sell at the close H days
  // later; at most `maxPos` positions, each 1/maxPos of the account; best probabilities first
  function trade(U, pred, { H, cost, pThr, maxPos, shorts, start }) {
    const open = [], daily = [], trades = [];
    for (let g = start; g < U.L - 1; g++) {
      // today's return of the positions held, entry-day open→close, then close→close; exits at today's close
      let r = 0;
      for (const pos of open) {
        const F = U.F[pos.sym], i = g + 1 - U.off[pos.sym];
        const prev = pos.entryG === g + 1 ? F.o[i] : F.c[i - 1];
        r += pos.side * (F.c[i] / prev - 1) / maxPos;
      }
      // costs on entry and exit legs
      r -= open.filter(p => p.entryG === g + 1).length * cost / maxPos;
      const leaving = open.filter(p => p.exitG === g + 1);
      r -= leaving.length * cost / maxPos;
      for (const p of leaving) { const F = U.F[p.sym]; const ret = p.side * (F.c[p.exitG - U.off[p.sym]] / F.o[p.entryG - U.off[p.sym]] - 1) - 2 * cost; trades.push({ ...p, ret }); }
      for (let q = open.length - 1; q >= 0; q--) if (open[q].exitG === g + 1) open.splice(q, 1);
      daily.push({ g: g + 1, r });
      // new entries decided at the close of g + 1, filled at the open of g + 2
      const d = g + 1;
      if (d + 1 >= U.L) continue;
      const held = new Set(open.map(p => p.sym));
      const cands = [];
      for (const sym of U.syms) {
        if (held.has(sym)) continue;
        const pr = pred[sym][d]; if (!pr) continue;
        const i = d + 1 - U.off[sym]; if (i < 1 || i >= U.F[sym].n) continue;
        if (pr.p >= pThr && pr.e > 2 * cost * 1e4) cands.push({ sym, side: 1, p: pr.p, e: pr.e, conf: pr.p });
        else if (shorts && pr.p <= 1 - pThr && pr.e < -2 * cost * 1e4) cands.push({ sym, side: -1, p: pr.p, e: pr.e, conf: 1 - pr.p });
      }
      cands.sort((a, b) => b.conf - a.conf);
      for (const c of cands.slice(0, Math.max(0, maxPos - open.length))) open.push({ ...c, entryG: d + 1, exitG: Math.min(U.L - 1, d + H) });
    }
    return summarise(daily.map(x => x.r), trades, daily.length ? daily[0].g : start);
  }
  function summarise(dr, trades, firstG) {
    let eq = 1, peak = 1, maxDD = 0; for (const r of dr) { eq *= 1 + r; peak = Math.max(peak, eq); maxDD = Math.min(maxDD, eq / peak - 1); }
    const m = mean(dr), sd = Math.sqrt(mean(dr.map(r => (r - m) ** 2)));
    const years = dr.length / 252;
    return { totalReturn: eq - 1, cagr: years > 0 ? Math.pow(eq, 1 / years) - 1 : 0, sharpe: sd > 0 ? (m / sd) * Math.sqrt(252) : 0, maxDD, days: dr.length,
      trades: trades ? trades.length : null, winRate: trades && trades.length ? trades.filter(t => t.ret > 0).length / trades.length : null,
      avgNetBp: trades && trades.length ? mean(trades.map(t => t.ret)) * 1e4 : null, tradesT: trades ? tstat(trades.map(t => t.ret)) : null, firstG };
  }
  function buyHold(U, start) {
    const dr = [];
    for (let g = start + 1; g < U.L; g++) { let s = 0, n = 0; for (const sym of U.syms) { const F = U.F[sym], i = g - U.off[sym]; if (i >= 1) { s += F.c[i] / F.c[i - 1] - 1; n++; } } dr.push(n ? s / n : 0); }
    return summarise(dr, null, start + 1);
  }

  // Per agent on unseen days: stock-picking power (cross-sectional IC each H days) and the edge of
  // following its strong calls after costs; market-wide agents (same score for every stock) get a
  // timing measure instead
  function agentStats(U, X, R, j, { start, H, cost, thr = 0.5 }) {
    const ics = [], edges = [], all = []; let spread = 0, nDates = 0;
    for (let g = start; g < U.L; g += H) {
      const xs = [], rs = [];
      for (const sym of U.syms) { const x = X[sym][g], r = R[sym][g]; if (x && fin(r)) { xs.push(x[j]); rs.push(r); } }
      if (xs.length < 5) continue;
      // market-wide = when it speaks, it says the same about every stock
      if (xs.some(v => v !== 0)) { nDates++; const mx = mean(xs); if (xs.some(v => Math.abs(v - mx) > 1e-9)) spread++; }
      const c = pearson(xs, rs); if (fin(c)) ics.push(c);
      const e = []; xs.forEach((v, q) => { if (Math.abs(v) >= thr) e.push(Math.sign(v) * rs[q]); });
      if (e.length) { edges.push(mean(e)); all.push(...e); }
    }
    const marketWide = nDates > 0 && spread / nDates < 0.2;
    // timing: does the average score predict the average H-day move?
    let timing = null;
    if (marketWide) {
      const xs = [], rs = [];
      for (let g = start; g < U.L; g += H) { const v = [], r = []; for (const sym of U.syms) { const x = X[sym][g], q = R[sym][g]; if (x && fin(q)) { v.push(x[j]); r.push(q); } } if (v.length >= 5) { xs.push(mean(v)); rs.push(mean(r)); } }
      const c = pearson(xs, rs); timing = { ic: c, icT: fin(c) && xs.length > 3 ? c * Math.sqrt((xs.length - 2) / Math.max(1e-9, 1 - c * c)) : 0 };
    }
    const gross = all.length ? mean(all) * 1e4 : 0;
    return { ic: mean(ics), icT: tstat(ics), dates: ics.length, marketWide, timing, signals: all.length, grossBp: gross, netBp: all.length ? gross - 2 * cost * 1e4 : 0, edgeT: tstat(edges) };
  }

  async function evaluateSwing(U, o = {}) {
    const ids = o.ids, names = o.names || ids, H = o.H || 5, cost = (o.costBps ?? 5) / 1e4;
    const refit = o.refit || 63, window = o.window || 750, pThr = o.pThr ?? 0.55, maxPos = o.maxPos || 10, shorts = !!o.shorts;
    const start = Math.max(o.start || 0, Math.min(U.L - 60, 60 + Math.max(250, Math.round(U.L * 0.3))));
    if (U.L - start < 60) throw new Error(`Only ${U.L} days of history; the swing lab needs at least ${start + 60}.`);
    const prog = (a, b) => (x) => o.onProgress && o.onProgress(a + (b - a) * x);
    const { X, R } = await scoreMatrix(U, { signalsAt: o.signalsAt, ids, H, onProgress: prog(0, 0.6) });
    o.onProgress && o.onProgress(0.62);
    const all = ids.map((_, j) => j), trendJ = ids.indexOf(o.trendId || 'earn');
    const W = await walkForward(U, X, R, { cols: all, H, start, refit, window });
    o.onProgress && o.onProgress(0.8);
    const WT = trendJ >= 0 ? await walkForward(U, X, R, { cols: [trendJ], H, start, refit, window }) : null;
    o.onProgress && o.onProgress(0.9);
    const opts = { H, cost, pThr, maxPos, shorts, start };
    const model = trade(U, W.pred, opts), trendOnly = WT ? trade(U, WT.pred, opts) : null, hold = buyHold(U, start);
    const agents = ids.map((id, j) => ({ id, name: names[j], ...agentStats(U, X, R, j, { start, H, cost }) }));
    // the combined model's own picking power and calibration on unseen days
    const ics = [], cal = [0, 0.45, 0.5, 0.55, 0.6, 1.01].slice(0, -1).map(() => ({ n: 0, up: 0, sum: 0, ps: 0 }));
    const edgesCal = [0, 0.45, 0.5, 0.55, 0.6, 1.01];
    for (let g = start; g < U.L; g += H) {
      const es = [], rs = [];
      for (const sym of U.syms) { const pr = W.pred[sym][g], r = R[sym][g]; if (pr && fin(r)) { es.push(pr.e); rs.push(r); } }
      if (es.length >= 5) { const c = pearson(es, rs); if (fin(c)) ics.push(c); }
    }
    for (let g = start; g < U.L; g++) for (const sym of U.syms) {
      const pr = W.pred[sym][g], r = R[sym][g]; if (!pr || !fin(r)) continue;
      const b = edgesCal.findIndex((lo, q) => q < edgesCal.length - 1 && pr.p >= lo && pr.p < edgesCal[q + 1]); if (b < 0) continue;
      cal[b].n++; cal[b].up += r > 0 ? 1 : 0; cal[b].sum += r; cal[b].ps += pr.p;
    }
    const calibration = cal.map((c, b) => ({ range: `${Math.round(edgesCal[b] * 100)}–${Math.min(100, Math.round(edgesCal[b + 1] * 100))}%`, n: c.n, meanP: c.n ? c.ps / c.n : NaN, upRate: c.n ? c.up / c.n : NaN, avgBp: c.n ? (c.sum / c.n) * 1e4 : NaN }));
    // today's decisions: a model fitted on everything whose outcome is known, applied to the last close
    const rowsNow = []; for (const sym of U.syms) for (let g = Math.max(0, U.L - 1 - H - window); g <= U.L - 1 - H; g++) { const x = X[sym][g], r = R[sym][g]; if (x && fin(r)) rowsNow.push({ x, r }); }
    const Mnow = fit(rowsNow, ids.length);
    const last = U.L - 1;
    const decisions = Mnow ? U.syms.map(sym => {
      const x = X[sym][last]; if (!x) return null;
      const pr = predict(Mnow, x);
      const action = pr.p >= pThr && pr.e > 2 * cost * 1e4 ? 'BUY' : pr.p <= 1 - pThr && pr.e < -2 * cost * 1e4 ? (shorts ? 'SELL SHORT' : 'AVOID / SELL') : 'WAIT';
      const contrib = ids.map((id, j) => ({ id, name: names[j], score: x[j], bp: Mnow.beta[j + 1] * x[j], logit: Mnow.w[j + 1] * x[j] }))
        .filter(c => Math.abs(c.logit) > 1e-6 || Math.abs(c.bp) > 1e-6).sort((a, b) => Math.abs(b.logit) - Math.abs(a.logit));
      const agree = contrib.filter(c => Math.sign(c.logit) === Math.sign(pr.p - 0.5)).length;
      return { sym, p: pr.p, e: pr.e, action, contrib, agree, against: contrib.length - agree, voting: contrib.length };
    }).filter(Boolean).sort((a, b) => Math.abs(b.p - 0.5) - Math.abs(a.p - 0.5)) : [];
    const weights = Mnow ? ids.map((id, j) => ({ id, name: names[j], bpPerUnit: Mnow.beta[j + 1], logit: Mnow.w[j + 1], impactBp: Math.abs(Mnow.beta[j + 1]) * Mnow.sd[j] })) : [];
    const combined = { ic: mean(ics), icT: tstat(ics), dates: ics.length };
    // verdict on unseen days
    const beatsHold = model.sharpe > hold.sharpe + 0.05, beatsTrend = !trendOnly || model.sharpe > trendOnly.sharpe + 0.05;
    let verdict;
    if (!model.trades || model.trades < 30) verdict = { level: 'nogo', text: `NO-GO: on unseen days the agents found only ${model.trades || 0} trades whose expected ${H}-day move beat the ${(cost * 2e4).toFixed(0)}bp round-trip cost.` };
    else if (combined.icT >= 2 && model.avgNetBp > 0 && beatsHold && beatsTrend) verdict = { level: 'go', text: `GO: on days the model hadn't seen, the agents together picked stocks reliably (IC ${combined.ic.toFixed(3)}, t ${combined.icT.toFixed(1)}) and trading them made ${model.avgNetBp.toFixed(0)}bp per trade after costs, with a better risk-adjusted return (Sharpe ${model.sharpe.toFixed(2)}) than buy & hold (${hold.sharpe.toFixed(2)}) and than the trend score alone (${trendOnly ? trendOnly.sharpe.toFixed(2) : '—'}).` };
    else if (model.avgNetBp > 0 && (beatsHold || combined.icT >= 2)) verdict = { level: 'borderline', text: `BORDERLINE: profitable after costs (${model.avgNetBp.toFixed(0)}bp per trade, Sharpe ${model.sharpe.toFixed(2)} vs ${hold.sharpe.toFixed(2)} for buy & hold) but ${combined.icT < 2 ? `the stock-picking power isn't reliable (t ${combined.icT.toFixed(1)}; needs 2)` : !beatsHold ? 'not better than simply holding the stocks' : `no better than the trend score alone (Sharpe ${trendOnly.sharpe.toFixed(2)})`}.` };
    else verdict = { level: 'nogo', text: `NO-GO: on unseen days, trading the agents' calls ${model.avgNetBp > 0 ? `made ${model.avgNetBp.toFixed(0)}bp per trade but with a worse risk-adjusted return (Sharpe ${model.sharpe.toFixed(2)}) than buy & hold (${hold.sharpe.toFixed(2)})` : `lost ${(-model.avgNetBp).toFixed(0)}bp per trade after costs`}.` };
    o.onProgress && o.onProgress(1);
    return { H, costBps: cost * 1e4, pThr, maxPos, shorts, start, startDate: o.dateOf ? o.dateOf(start) : start, endDate: o.dateOf ? o.dateOf(U.L - 1) : U.L - 1, fits: W.fits.length,
      agents, combined, calibration, model, trendOnly, hold, weights, decisions, verdict };
  }

  root.ShoalSwing = { evaluateSwing, fit, predict };
})(typeof window !== 'undefined' ? window : globalThis);

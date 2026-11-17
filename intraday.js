// Shoal intraday lab (Phase 1): does any price/volume agent predict the next 15–60 minutes well enough to
// beat trading costs? Plain browser script (window.ShoalIntraday); the tests load it in Node through vm.
//
// Pipeline: 5-minute bars → regular-session days (9:30–16:00 New York) → 11 agents each give a score in
// [-1, 1] at the close of every bar (positive = expects a rise) using only bars up to that close →
// evaluation on the following H bars: each agent's predictive power (information coefficient) and edge
// after costs, a combined model fitted on the earlier days and tested on the later ones, and a
// non-overlapping trading backtest of that model, flat at every close.
(function (root) {
  'use strict';

  const AGENTS = [
    { id: 'orb',      name: 'Opening range',        desc: 'Price above (+) or below (−) the first 30 minutes\' high/low, in ranges' },
    { id: 'vwap',     name: 'VWAP stretch',          desc: 'Distance from the day\'s volume-weighted average price; expects a snap back' },
    { id: 'mom',      name: 'Short-term momentum',   desc: 'Return over the last 30 minutes, scaled by volatility' },
    { id: 'rsi',      name: 'RSI (5-min)',           desc: 'RSI(14) on 5-minute bars; oversold (+) / overbought (−)' },
    { id: 'volsurge', name: 'Volume surge',          desc: 'Unusual volume for this time of day, in the direction of the bar' },
    { id: 'pressure', name: 'Buying vs selling',     desc: 'Volume on rising bars minus volume on falling bars, last hour' },
    { id: 'gap',      name: 'Gap',                   desc: 'This morning\'s gap from yesterday\'s close while unfilled; expects it to fill' },
    { id: 'market',   name: 'Market direction',      desc: 'SPY over the last 30 minutes' },
    { id: 'relstr',   name: 'Relative strength',     desc: 'The stock\'s move today minus SPY\'s' },
    { id: 'tod',      name: 'Time of day',           desc: 'Average move at this time of day over the previous 20 days (all stocks)' },
    { id: 'trend',    name: 'Multi-day trend',       desc: 'Return over the last 10 trading days, scaled by daily volatility' },
  ];
  const IDS = AGENTS.map(a => a.id);
  const OPEN_MIN = 570, CLOSE_MIN = 960; // 9:30 and 16:00 New York, minutes after midnight

  const fin = Number.isFinite;
  const tanh = Math.tanh;

  // ── New York time without a library: cache the UTC offset per hour (DST switches on the hour) ──
  const OFF = new Map();
  let FMT = null;
  function etOffset(ms) {
    const key = Math.floor(ms / 3600000);
    let off = OFF.get(key);
    if (off == null) {
      FMT = FMT || new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
      const p = {};
      for (const x of FMT.formatToParts(new Date(key * 3600000))) p[x.type] = x.value;
      off = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute) - key * 3600000;
      OFF.set(key, off);
    }
    return off;
  }
  function etParts(ms) {
    const d = new Date(ms + etOffset(ms));
    return { date: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes() };
  }

  // ── Bars → regular-session days, one array slot per bar-time (missing slots carried forward) ──
  function prepare(barsBySym, o = {}) {
    const tf = o.tf || 5, slots = Math.round((CLOSE_MIN - OPEN_MIN) / tf);
    const S = {};
    for (const [sym, arr] of Object.entries(barsBySym || {})) {
      const byDay = new Map();
      for (const b of arr || []) {
        const ms = typeof b.t === 'number' ? b.t : Date.parse(b.t);
        const c = +b.c;
        if (!fin(ms) || !(c > 0)) continue;
        const { date, min } = etParts(ms);
        if (min < OPEN_MIN || min >= CLOSE_MIN) continue; // regular session only
        const slot = Math.floor((min - OPEN_MIN) / tf);
        if (!byDay.has(date)) byDay.set(date, new Map());
        byDay.get(date).set(slot, { o: +b.o > 0 ? +b.o : c, h: +b.h > 0 ? +b.h : c, l: +b.l > 0 ? +b.l : c, c, v: +b.v > 0 ? +b.v : 0 });
      }
      const days = [];
      for (const date of [...byDay.keys()].sort()) {
        const m = byDay.get(date);
        if (m.size < slots * 0.5) continue; // half-empty day (holiday half-session or thin data)
        const first = m.get(Math.min(...m.keys()));
        const D = { date, o: new Float64Array(slots), h: new Float64Array(slots), l: new Float64Array(slots), c: new Float64Array(slots), v: new Float64Array(slots), real: new Uint8Array(slots) };
        let prev = first.o;
        for (let k = 0; k < slots; k++) {
          const x = m.get(k);
          if (x) { D.o[k] = x.o; D.h[k] = Math.max(x.h, x.o, x.c); D.l[k] = Math.min(x.l, x.o, x.c); D.c[k] = x.c; D.v[k] = x.v; D.real[k] = 1; prev = x.c; }
          else { D.o[k] = D.h[k] = D.l[k] = D.c[k] = prev; D.v[k] = 0; }
        }
        days.push(D);
      }
      if (days.length >= 2) S[sym] = days;
    }
    const syms = Object.keys(S);
    const market = o.market && S[o.market] ? o.market : S.SPY ? 'SPY' : null;
    const dates = [...new Set(syms.flatMap(s => S[s].map(d => d.date)))].sort();
    return { tf, slots, S, syms, market, dates };
  }

  // ── Agent scores: for every symbol/day, an array per agent (NaN where not yet defined) ──
  // Every value at bar k uses bars ≤ k of that day and earlier days only.
  function computeScores(P) {
    const { slots, S, market } = P;
    const mktByDate = market ? new Map(S[market].map(d => [d.date, d])) : new Map();
    const out = {};
    for (const sym of P.syms) {
      const days = S[sym];
      out[sym] = days.map(() => Object.fromEntries(IDS.map(id => [id, new Float64Array(slots).fill(NaN)])));
      // flattened series for RSI and bar-range average across days
      const n = days.length * slots, C = new Float64Array(n), R = new Float64Array(n);
      days.forEach((D, d) => { for (let k = 0; k < slots; k++) { C[d * slots + k] = D.c[k]; R[d * slots + k] = D.h[k] - D.l[k]; } });
      const rsi = new Float64Array(n).fill(NaN);
      { let ag = 0, al = 0; for (let i = 1; i < n; i++) { const ch = C[i] - C[i - 1], g = Math.max(ch, 0), l = Math.max(-ch, 0);
        if (i <= 14) { ag += g / 14; al += l / 14; if (i === 14) rsi[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); }
        else { ag = (ag * 13 + g) / 14; al = (al * 13 + l) / 14; rsi[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al); } } }
      const atr = new Float64Array(n).fill(NaN);
      { let s = 0; for (let i = 0; i < n; i++) { s += R[i]; if (i >= 12) s -= R[i - 12]; if (i >= 11) atr[i] = s / 12; } }
      const closes = days.map(D => D.c[slots - 1]);
      days.forEach((D, d) => {
        const A = out[sym][d], base = d * slots;
        if (d === 0) return; // needs a previous day
        const prevC = closes[d - 1], P0 = days[d - 1];
        const prevRangePct = (Math.max(...P0.h) - Math.min(...P0.l)) / prevC;
        // daily volatility and 10-day trend from previous closes
        const dr = []; for (let j = Math.max(1, d - 20); j < d; j++) dr.push(closes[j] / closes[j - 1] - 1);
        const dvol = dr.length >= 5 ? Math.sqrt(dr.reduce((a, x) => a + x * x, 0) / dr.length) : NaN;
        const ref10 = d >= 10 ? closes[d - 10] : NaN;
        // average volume per slot over the previous 10 days
        const vAvg = new Float64Array(slots);
        const vDays = Math.min(10, d);
        for (let j = d - vDays; j < d; j++) for (let k = 0; k < slots; k++) vAvg[k] += days[j].v[k] / vDays;
        const M = mktByDate.get(D.date);
        const gap = D.o[0] / prevC - 1;
        let orH = -Infinity, orL = Infinity, pv = 0, vv = 0, lowSoFar = Infinity, highSoFar = -Infinity;
        for (let k = 0; k < slots; k++) {
          const i = base + k, c = D.c[k], a = atr[i];
          const tp = (D.h[k] + D.l[k] + c) / 3; pv += tp * D.v[k]; vv += D.v[k];
          lowSoFar = Math.min(lowSoFar, D.l[k]); highSoFar = Math.max(highSoFar, D.h[k]);
          if (k < 6) { orH = Math.max(orH, D.h[k]); orL = Math.min(orL, D.l[k]); }
          const aPct = a / c;
          // opening range breakout (after the first 30 minutes)
          if (k >= 6 && a > 0) A.orb[k] = c > orH ? Math.min(1, (c - orH) / a) : c < orL ? -Math.min(1, (orL - c) / a) : 0;
          // VWAP stretch: expects a snap back
          if (vv > 0 && a > 0) A.vwap[k] = -tanh((c - pv / vv) / a / 2);
          // 30-minute momentum
          if (k >= 6 && aPct > 0) A.mom[k] = tanh((c / D.c[k - 6] - 1) / (aPct * Math.sqrt(6)));
          // RSI on 5-minute bars
          if (fin(rsi[i])) A.rsi[k] = (50 - rsi[i]) / 50;
          // volume surge in the bar's direction
          if (vAvg[k] > 0) A.volsurge[k] = Math.sign(c - D.o[k]) * tanh(Math.max(0, D.v[k] / vAvg[k] - 1));
          // buying vs selling pressure, last hour
          { let up = 0, tot = 0; for (let j = Math.max(0, k - 11); j <= k; j++) { tot += D.v[j]; up += D.v[j] * Math.sign(D.c[j] - D.o[j]); } if (tot > 0) A.pressure[k] = up / tot; }
          // unfilled gap: expects it to fill
          if (prevRangePct > 0) { const filled = gap > 0 ? lowSoFar <= prevC : highSoFar >= prevC; A.gap[k] = filled ? 0 : -Math.sign(gap) * Math.min(1, Math.abs(gap) / prevRangePct); }
          // market direction and relative strength (need SPY's bars for this day)
          if (M && k >= 6) { const mr = M.c[k] / M.c[k - 6] - 1; A.market[k] = aPct > 0 ? tanh(mr / (aPct * Math.sqrt(6))) : NaN; }
          if (M && aPct > 0) A.relstr[k] = tanh(((c / D.o[0]) - (M.c[k] / M.o[0])) / (aPct * 3));
          // multi-day trend
          if (fin(ref10) && dvol > 0) A.trend[k] = tanh((c / ref10 - 1) / (dvol * Math.sqrt(10)));
        }
      });
    }
    return out;
  }

  // Time-of-day agent: average forward H-bar return at each slot over the previous `look` days (all
  // stocks), as a t-like score. Needs the horizon, so it is filled in per evaluation.
  function fillTimeOfDay(P, scores, H, look = 20) {
    const { slots, S } = P, dIdx = new Map(P.dates.map((d, i) => [d, i]));
    const sum = P.dates.map(() => new Float64Array(slots)), sq = P.dates.map(() => new Float64Array(slots)), cnt = P.dates.map(() => new Float64Array(slots));
    for (const sym of P.syms) for (const D of S[sym]) { const g = dIdx.get(D.date); for (let k = 0; k + H < slots; k++) { const r = D.c[k + H] / D.c[k] - 1; sum[g][k] += r; sq[g][k] += r * r; cnt[g][k]++; } }
    for (const sym of P.syms) S[sym].forEach((D, d) => {
      const g = dIdx.get(D.date), A = scores[sym][d].tod;
      A.fill(NaN);
      if (g < 5) return;
      for (let k = 0; k + H < slots; k++) {
        let s = 0, q = 0, n = 0;
        for (let j = Math.max(0, g - look); j < g; j++) { s += sum[j][k]; q += sq[j][k]; n += cnt[j][k]; }
        if (n < 20) continue;
        const m = s / n, sd = Math.sqrt(Math.max(1e-12, q / n - m * m));
        A[k] = tanh((m / (sd / Math.sqrt(n))) / 2);
      }
    });
  }

  // ── Statistics helpers ──
  const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
  const tstat = (a) => { if (a.length < 3) return 0; const m = mean(a), v = a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1); return v > 0 ? m / Math.sqrt(v / a.length) : 0; };
  // Uncentred correlation: Σsr / √(Σs²·Σr²). With overlapping bars from one day, ordinary (centred)
  // correlation is biased towards mean reversion even for a pure random walk; this one is not.
  function ucorr(x, y) {
    let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < x.length; i++) { sxy += x[i] * y[i]; sxx += x[i] * x[i]; syy += y[i] * y[i]; }
    return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN;
  }
  function pearson(x, y) {
    const n = x.length; if (n < 3) return NaN;
    let mx = 0, my = 0; for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; } mx /= n; my /= n;
    let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < n; i++) { const a = x[i] - mx, b = y[i] - my; sxy += a * b; sxx += a * a; syy += b * b; }
    return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN;
  }
  // Solve (A) x = b for a small dense system (Gaussian elimination with partial pivoting)
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

  // ── Samples: one row per symbol, day and bar with a full H-bar future inside the same session ──
  function collect(P, scores, H) {
    const dIdx = new Map(P.dates.map((d, i) => [d, i])), rows = [];
    for (const sym of P.syms) {
      if (sym === P.market) continue; // SPY is the market input, not a trading target
      P.S[sym].forEach((D, d) => {
        if (d === 0) return;
        const A = scores[sym][d], g = dIdx.get(D.date);
        for (let k = 1; k + H < P.slots; k++) {
          if (!D.real[k]) continue;
          rows.push({ sym, g, d, k, x: IDS.map(id => A[id][k]), r: D.c[k + H] / D.c[k] - 1 });
        }
      });
    }
    return rows;
  }

  // Per-agent: daily information coefficient (correlation of score with the next-H return) and the
  // edge of following strong signals (|score| ≥ thr) before and after a round-trip cost
  function agentStats(rows, j, cost, thr) {
    const byDay = new Map();
    for (const w of rows) { const s = w.x[j]; if (!fin(s)) continue; let e = byDay.get(w.g); if (!e) byDay.set(w.g, e = { s: [], r: [], edge: [] }); e.s.push(s); e.r.push(w.r); if (Math.abs(s) >= thr) e.edge.push(Math.sign(s) * w.r); }
    const ics = [], edges = [], all = [];
    for (const e of byDay.values()) { if (e.s.length >= 20) { const c = ucorr(e.s, e.r); if (fin(c)) ics.push(c); } if (e.edge.length) { edges.push(mean(e.edge)); all.push(...e.edge); } }
    const gross = mean(all) * 1e4;
    return { ic: mean(ics), icT: tstat(ics), days: ics.length, signals: all.length, grossBp: all.length ? gross : 0, netBp: all.length ? gross - 2 * cost * 1e4 : 0, edgeT: tstat(edges) };
  }

  // Combined model: ridge regression for the expected H-bar return and logistic regression for the
  // probability of a rise, both on the agent scores (missing = 0), fitted on training rows only.
  function fitCombiner(rows, { ridge = 0.02, l2 = 1e-3, step = 2 } = {}) {
    const p = IDS.length + 1, XtX = Array.from({ length: p }, () => new Float64Array(p)), Xty = new Float64Array(p);
    const xs = [], ys = [];
    for (let i = 0; i < rows.length; i += step) { const x = [1, ...rows[i].x.map(v => (fin(v) ? v : 0))]; xs.push(x); ys.push(rows[i].r); }
    const n = xs.length;
    if (n < 200) return null;
    for (let i = 0; i < n; i++) { const x = xs[i]; for (let a = 0; a < p; a++) { Xty[a] += x[a] * ys[i] * 1e4; for (let b = 0; b < p; b++) XtX[a][b] += x[a] * x[b]; } }
    const A = XtX.map((r, a) => r.map((v, b) => v + (a === b && a > 0 ? ridge * n : 0)));
    const beta = solve(A.map(r => [...r]), [...Xty]); // bp per unit score
    // logistic: Newton steps
    let w = new Float64Array(p);
    for (let it = 0; it < 8; it++) {
      const g = new Float64Array(p), Hm = Array.from({ length: p }, () => new Float64Array(p));
      for (let i = 0; i < n; i++) {
        const x = xs[i]; let z = 0; for (let a = 0; a < p; a++) z += w[a] * x[a];
        const q = 1 / (1 + Math.exp(-z)), y = ys[i] > 0 ? 1 : 0, ww = q * (1 - q);
        for (let a = 0; a < p; a++) { g[a] += (q - y) * x[a]; for (let b = 0; b < p; b++) Hm[a][b] += ww * x[a] * x[b]; }
      }
      for (let a = 1; a < p; a++) { g[a] += l2 * n * w[a]; Hm[a][a] += l2 * n; }
      const dlt = solve(Hm.map(r => [...r]), [...g]);
      w = w.map((v, a) => v - dlt[a]);
    }
    // how much each agent moves the expected return: |β| × spread of its scores
    const sd = IDS.map((_, j) => { let s = 0, q = 0; for (const x of xs) { s += x[j + 1]; q += x[j + 1] ** 2; } const m = s / n; return Math.sqrt(Math.max(0, q / n - m * m)); });
    return { beta, w: [...w], sd, n };
  }
  const predict = (M, x) => {
    let e = M.beta[0], z = M.w[0];
    for (let j = 0; j < x.length; j++) { const v = fin(x[j]) ? x[j] : 0; e += M.beta[j + 1] * v; z += M.w[j + 1] * v; }
    return { e, p: 1 / (1 + Math.exp(-z)) };
  };

  // Non-overlapping trading test on the test days: decide at a bar's close, enter at the next bar's open,
  // exit at the close H bars later (or the last bar of the day), paying the cost on both sides.
  function backtest(P, scores, M, { H, cost, pThr = 0.55, shorts = true, testFrom }) {
    const dIdx = new Map(P.dates.map((d, i) => [d, i])), names = P.syms.filter(s => s !== P.market);
    const daily = new Map(), trades = [], hold = new Map();
    for (const sym of names) P.S[sym].forEach((D, d) => {
      const g = dIdx.get(D.date); if (g < testFrom || d === 0) return;
      const A = scores[sym][d];
      daily.set(g, daily.get(g) || 0);
      // benchmark: hold this stock from the second bar's open to the close
      hold.set(g, (hold.get(g) || 0) + (D.c[P.slots - 1] / D.o[1] - 1 - 2 * cost) / names.length);
      for (let k = 1; k < P.slots - 2; ) {
        if (!D.real[k]) { k++; continue; }
        const { e, p } = predict(M, IDS.map(id => A[id][k]));
        const side = p >= pThr && e > 2 * cost * 1e4 ? 1 : shorts && p <= 1 - pThr && e < -2 * cost * 1e4 ? -1 : 0;
        if (!side) { k++; continue; }
        const xk = Math.min(k + H, P.slots - 1), entry = D.o[k + 1], exit = D.c[xk];
        const ret = side * (exit / entry - 1) - 2 * cost;
        trades.push({ sym, date: D.date, k, side, p, e, ret });
        daily.set(g, daily.get(g) + ret / names.length);
        k = xk + 1;
      }
    });
    const days = [...daily.keys()].sort((a, b) => a - b), dr = days.map(g => daily.get(g)), hr = days.map(g => hold.get(g) || 0);
    let eq = 1, peak = 1, maxDD = 0; for (const r of dr) { eq *= 1 + r; peak = Math.max(peak, eq); maxDD = Math.min(maxDD, eq / peak - 1); }
    const holdRet = hr.reduce((a, r) => a * (1 + r), 1) - 1;
    const wins = trades.filter(t => t.ret > 0).length;
    return { days: days.length, trades: trades.length, perDay: trades.length / Math.max(1, days.length), winRate: trades.length ? wins / trades.length : 0,
      avgNetBp: trades.length ? mean(trades.map(t => t.ret)) * 1e4 : 0, totalReturn: eq - 1, maxDD, dailyT: tstat(dr), holdReturn: holdRet,
      longs: trades.filter(t => t.side > 0).length, shorts: trades.filter(t => t.side < 0).length, sample: trades.slice(-20) };
  }

  // ── The whole Phase 1 test ──
  function evaluate(P, o = {}) {
    const H = o.H || 6, cost = (o.costBps ?? 5) / 1e4, thr = o.thr ?? 0.5, split = o.split ?? 0.6;
    const scores = o.scores || computeScores(P);
    fillTimeOfDay(P, scores, H);
    const rows = collect(P, scores, H);
    const testFrom = Math.max(1, Math.floor(P.dates.length * split));
    const train = rows.filter(w => w.g < testFrom), test = rows.filter(w => w.g >= testFrom);
    const agents = AGENTS.map((a, j) => ({ ...a, train: agentStats(train, j, cost, thr), test: agentStats(test, j, cost, thr) }));
    // how alike the agents are (average absolute correlation of their scores on training rows)
    const corr = IDS.map((_, a) => IDS.map((_, b) => {
      if (a === b) return 1;
      const xs = [], ys = []; for (let i = 0; i < train.length; i += 3) { const u = train[i].x[a], v = train[i].x[b]; if (fin(u) && fin(v)) { xs.push(u); ys.push(v); } }
      return pearson(xs, ys);
    }));
    const M = fitCombiner(train);
    let combined = null, calibration = [], bt = null, grid = [];
    if (M) {
      const pr = test.map(w => ({ ...predict(M, w.x), r: w.r, g: w.g }));
      const byDay = new Map(); for (const q of pr) { let e = byDay.get(q.g); if (!e) byDay.set(q.g, e = { e: [], r: [] }); e.e.push(q.e); e.r.push(q.r); }
      const ics = [...byDay.values()].filter(e => e.e.length >= 20).map(e => ucorr(e.e, e.r)).filter(fin);
      combined = { ic: mean(ics), icT: tstat(ics), hit: pr.length ? pr.filter(q => (q.p >= 0.5) === (q.r > 0)).length / pr.length : 0, n: pr.length,
        weights: AGENTS.map((a, j) => ({ id: a.id, name: a.name, bpPerUnit: M.beta[j + 1], impactBp: Math.abs(M.beta[j + 1]) * M.sd[j], logit: M.w[j + 1] })) };
      const edges = [0, 0.45, 0.5, 0.55, 0.6, 1.01];
      calibration = edges.slice(0, -1).map((lo, b) => { const hi = edges[b + 1], s = pr.filter(q => q.p >= lo && q.p < hi);
        return { range: `${(lo * 100).toFixed(0)}–${Math.min(100, hi * 100).toFixed(0)}%`, n: s.length, meanP: s.length ? mean(s.map(q => q.p)) : NaN, upRate: s.length ? s.filter(q => q.r > 0).length / s.length : NaN, avgBp: s.length ? mean(s.map(q => q.r)) * 1e4 : NaN }; });
      bt = backtest(P, scores, M, { H, cost, pThr: o.pThr ?? 0.55, shorts: o.shorts !== false, testFrom });
      grid = [0.52, 0.55, 0.6].map(pThr => { const b = backtest(P, scores, M, { H, cost, pThr, shorts: o.shorts !== false, testFrom }); return { pThr, trades: b.trades, avgNetBp: b.avgNetBp, totalReturn: b.totalReturn, dailyT: b.dailyT }; });
    }
    // Verdict, judged on the test days only
    const strong = agents.filter(a => a.test.icT >= 2 && a.train.icT >= 1 && Math.sign(a.test.ic) === Math.sign(a.train.ic));
    let verdict;
    const testDays = P.dates.length - testFrom;
    if (!bt || testDays < 8) verdict = { level: 'insufficient', text: `Not enough to judge: ${testDays} test days (need 8+). Load more days of history.` };
    else if (bt.trades < 30) verdict = { level: 'nogo', text: `NO-GO: on ${testDays} days they hadn't seen, the combined agents ${bt.trades ? `expected a move bigger than the ${(cost * 2e4).toFixed(0)}bp round-trip cost only ${bt.trades} time${bt.trades === 1 ? '' : 's'}` : `never expected a move bigger than the ${(cost * 2e4).toFixed(0)}bp round-trip cost`}${strong.length ? `, although ${strong.map(a => a.name).join(', ')} showed some predictive power before costs` : ''}.` };
    else if (bt.avgNetBp > 0 && bt.dailyT >= 2 && strong.length) verdict = { level: 'go', text: `GO: after ${(cost * 2e4).toFixed(0)}bp round-trip costs the combined agents made ${bt.avgNetBp.toFixed(1)}bp per trade on days they hadn't seen (daily t ${bt.dailyT.toFixed(1)}), and ${strong.map(a => a.name).join(', ')} predicted reliably on their own.` };
    else if (bt.avgNetBp > 0) verdict = { level: 'borderline', text: `BORDERLINE: positive after costs (${bt.avgNetBp.toFixed(1)}bp per trade on unseen days) but not reliably (daily t ${bt.dailyT.toFixed(1)}; needs 2${strong.length ? '' : ', and no single agent predicted reliably'}). Collect more days before building on it.` };
    else verdict = { level: 'nogo', text: `NO-GO: on days they hadn't seen, the combined agents lost ${(-bt.avgNetBp).toFixed(1)}bp per trade after ${(cost * 2e4).toFixed(0)}bp round-trip costs${strong.length ? `, although ${strong.map(a => a.name).join(', ')} showed some predictive power before costs` : ''}.` };
    return { H, minutes: H * P.tf, costBps: cost * 1e4, thr, split, trainDays: testFrom, testDays: P.dates.length - testFrom, from: P.dates[0], to: P.dates[P.dates.length - 1], testFromDate: P.dates[testFrom],
      symbols: P.syms.filter(s => s !== P.market), market: P.market, rows: rows.length, agents, corr, combined, calibration, backtest: bt, grid, verdict };
  }

  // ── Fictional 5-minute market for trying the lab without a broker (and for tests) ──
  // `plant` adds a momentum effect: each bar drifts by plant × the last 30 minutes' return.
  function synthIntraday({ syms = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF', 'GGG', 'HHH'], days = 40, seed = 7, plant = 0, endDate = null, extended = true } = {}) {
    let s = seed >>> 0;
    const rnd = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const gauss = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    const slots = 78, all = ['SPY', ...syms];
    const out = Object.fromEntries(all.map(x => [x, []]));
    const px = Object.fromEntries(all.map((x, i) => [x, 50 + 30 * i]));
    const beta = Object.fromEntries(all.map(x => [x, x === 'SPY' ? 1 : 0.6 + rnd() * 0.8]));
    // weekdays ending at endDate (default: yesterday)
    const dates = []; const d = endDate ? new Date(endDate + 'T12:00:00Z') : new Date(Date.now() - 86400000);
    while (dates.length < days) { const wd = d.getUTCDay(); if (wd && wd < 6) dates.unshift(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() - 1); }
    for (const date of dates) {
      const noon = Date.parse(date + 'T16:00:00Z'), off = etOffset(noon), t0 = Date.parse(date + 'T09:30:00Z') - off;
      const gapM = gauss() * 0.004;
      const hist = Object.fromEntries(all.map(x => [x, []]));
      for (let k = 0; k < slots; k++) {
        const vol = 0.0012 * (1 + 1.5 * Math.exp(-k / 6) + 0.8 * Math.exp(-(slots - 1 - k) / 6));
        const m = gauss() * vol * 0.8 + (k === 0 ? gapM : 0);
        for (const x of all) {
          const hst = hist[x];
          const mom = plant && hst.length >= 6 ? plant * (hst[hst.length - 1] / hst[hst.length - 6] - 1) : 0;
          const gap = k === 0 ? (x === 'SPY' ? gapM : beta[x] * gapM + gauss() * 0.006) : 0;
          const r = (x === 'SPY' ? m - (k === 0 ? gapM : 0) : beta[x] * (m - (k === 0 ? gapM : 0)) + gauss() * vol) + mom;
          const o = px[x] * (1 + gap), c = o * (1 + r), h = Math.max(o, c) * (1 + Math.abs(gauss()) * vol * 0.4), l = Math.min(o, c) * (1 - Math.abs(gauss()) * vol * 0.4);
          const v = Math.round(20000 * (1 + 2 * Math.exp(-k / 5) + Math.exp(-(slots - 1 - k) / 5)) * Math.exp(gauss() * 0.4));
          out[x].push({ t: new Date(t0 + k * 300000).toISOString(), o, h, l, c, v });
          px[x] = c; hst.push(c);
        }
      }
      if (extended) for (const x of all) out[x].push({ t: new Date(t0 - 90 * 60000).toISOString(), o: px[x], h: px[x], l: px[x], c: px[x], v: 100 }); // pre-market bar to be filtered out
    }
    for (const x of all) out[x].sort((a, b) => a.t.localeCompare(b.t));
    return out;
  }

  root.ShoalIntraday = { AGENTS, IDS, etParts, prepare, computeScores, fillTimeOfDay, collect, fitCombiner, predict, backtest, evaluate, synthIntraday };
})(typeof window !== 'undefined' ? window : globalThis);

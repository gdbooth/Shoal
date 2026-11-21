// Shoal signal engine — indicators, regime detection, the 16 agents, ensemble and backtester.
//
// Plain browser script (no modules, no JSX): index.html loads it with <script src="signals.js">
// and reads window.ShoalSignals. Tests load the same file in Node through vm.
//
// Everything works on daily OHLCV bars ({ o, h, l, c, v } arrays, oldest first). All indicators
// are causal: the value at index i uses bars 0..i only, so signals at i can be traded at i + 1.
// Where a broker supplies no volume (e.g. IG spread bets) the volume-based agents fall back to
// price-only versions.
(function (root) {
  'use strict';

  // ── Small numeric helpers ──────────────────────────────────────────────────
  const fin = Number.isFinite;
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  // Map a non-negative magnitude to a 0..0.95 strength. scale = magnitude giving ~0.63.
  const squash = (x, scale) => (fin(x) && x > 0 ? Math.min(0.95, 1 - Math.exp(-x / scale)) : 0);
  const nanArr = (n) => new Array(n).fill(NaN);

  function sma(x, n) {
    const out = nanArr(x.length);
    let s = 0, cnt = 0;
    for (let i = 0; i < x.length; i++) {
      if (fin(x[i])) { s += x[i]; cnt++; } else { s = 0; cnt = 0; continue; }
      if (cnt > n) { s -= x[i - n]; cnt = n; }
      if (cnt === n) out[i] = s / n;
    }
    return out;
  }

  // EMA seeded with the SMA of the first n finite values; skips leading NaNs.
  function ema(x, n) {
    const out = nanArr(x.length);
    const k = 2 / (n + 1);
    let start = 0;
    while (start < x.length && !fin(x[start])) start++;
    if (start + n > x.length) return out;
    let e = 0;
    for (let i = start; i < start + n; i++) e += x[i];
    e /= n;
    out[start + n - 1] = e;
    for (let i = start + n; i < x.length; i++) {
      if (!fin(x[i])) continue;
      e = x[i] * k + e * (1 - k);
      out[i] = e;
    }
    return out;
  }

  // Wilder's smoothing (RMA), seeded with the SMA of the first n finite values.
  function rma(x, n) {
    const out = nanArr(x.length);
    let start = 0;
    while (start < x.length && !fin(x[start])) start++;
    if (start + n > x.length) return out;
    let r = 0;
    for (let i = start; i < start + n; i++) r += x[i];
    r /= n;
    out[start + n - 1] = r;
    for (let i = start + n; i < x.length; i++) {
      if (!fin(x[i])) continue;
      r = (r * (n - 1) + x[i]) / n;
      out[i] = r;
    }
    return out;
  }

  // Rolling population standard deviation.
  function rstd(x, n) {
    const out = nanArr(x.length);
    for (let i = n - 1; i < x.length; i++) {
      let s = 0, ok = true;
      for (let j = i - n + 1; j <= i; j++) { if (!fin(x[j])) { ok = false; break; } s += x[j]; }
      if (!ok) continue;
      const m = s / n;
      let v = 0;
      for (let j = i - n + 1; j <= i; j++) v += (x[j] - m) ** 2;
      out[i] = Math.sqrt(v / n);
    }
    return out;
  }

  function rollMax(x, n, excludeCurrent) {
    const out = nanArr(x.length);
    const off = excludeCurrent ? 1 : 0;
    for (let i = n - 1 + off; i < x.length; i++) {
      let m = -Infinity;
      for (let j = i - n + 1 - off; j <= i - off; j++) m = Math.max(m, x[j]);
      out[i] = m;
    }
    return out;
  }

  function rollMin(x, n, excludeCurrent) {
    const out = nanArr(x.length);
    const off = excludeCurrent ? 1 : 0;
    for (let i = n - 1 + off; i < x.length; i++) {
      let m = Infinity;
      for (let j = i - n + 1 - off; j <= i - off; j++) m = Math.min(m, x[j]);
      out[i] = m;
    }
    return out;
  }

  // Fraction of the previous `look` finite values strictly below x[i] (0..1).
  function pctRank(x, look) {
    const out = nanArr(x.length);
    for (let i = 0; i < x.length; i++) {
      if (!fin(x[i])) continue;
      let below = 0, cnt = 0;
      for (let j = Math.max(0, i - look); j < i; j++) {
        if (!fin(x[j])) continue;
        cnt++;
        if (x[j] < x[i]) below++;
      }
      if (cnt >= Math.min(look, 20)) out[i] = below / cnt;
    }
    return out;
  }

  // ── Indicators ─────────────────────────────────────────────────────────────
  const ind = {
    sma, ema, rma, rstd, rollMax, rollMin, pctRank,

    returns(c) {
      const out = nanArr(c.length);
      for (let i = 1; i < c.length; i++) out[i] = c[i] / c[i - 1] - 1;
      return out;
    },

    nDayReturn(c, n) {
      const out = nanArr(c.length);
      for (let i = n; i < c.length; i++) out[i] = c[i] / c[i - n] - 1;
      return out;
    },

    bollinger(c, n = 20, k = 2) {
      const mid = sma(c, n), sd = rstd(c, n);
      const up = mid.map((m, i) => m + k * sd[i]);
      const lo = mid.map((m, i) => m - k * sd[i]);
      const pctB = c.map((x, i) => (up[i] - lo[i] > 0 ? (x - lo[i]) / (up[i] - lo[i]) : NaN));
      const bw = mid.map((m, i) => (m > 0 ? (up[i] - lo[i]) / m : NaN));
      return { mid, up, lo, pctB, bw };
    },

    trueRange(h, l, c) {
      return h.map((hi, i) => (i === 0
        ? hi - l[i]
        : Math.max(hi - l[i], Math.abs(hi - c[i - 1]), Math.abs(l[i] - c[i - 1]))));
    },

    atr(h, l, c, n = 14) { return rma(ind.trueRange(h, l, c), n); },

    keltner(h, l, c, n = 20, mult = 1.5) {
      const mid = ema(c, n), a = ind.atr(h, l, c, n);
      return { mid, up: mid.map((m, i) => m + mult * a[i]), lo: mid.map((m, i) => m - mult * a[i]) };
    },

    // Wilder RSI
    rsi(c, n = 14) {
      const g = nanArr(c.length), d = nanArr(c.length);
      for (let i = 1; i < c.length; i++) {
        const ch = c[i] - c[i - 1];
        g[i] = Math.max(0, ch);
        d[i] = Math.max(0, -ch);
      }
      const ag = rma(g, n), ad = rma(d, n);
      return ag.map((x, i) => (!fin(x) || !fin(ad[i]) ? NaN : ad[i] === 0 ? 100 : 100 - 100 / (1 + x / ad[i])));
    },

    macd(c, fast = 12, slow = 26, signal = 9) {
      const ef = ema(c, fast), es = ema(c, slow);
      const line = ef.map((x, i) => x - es[i]);
      const sig = ema(line, signal);
      return { line, signal: sig, hist: line.map((x, i) => x - sig[i]), emaFast: ef, emaSlow: es };
    },

    stochastic(h, l, c, n = 14, d = 3) {
      const hh = rollMax(h, n), ll = rollMin(l, n);
      const k = c.map((x, i) => (hh[i] - ll[i] > 0 ? (100 * (x - ll[i])) / (hh[i] - ll[i]) : NaN));
      return { k, d: sma(k, d) };
    },

    // Wilder ADX with +DI / −DI
    adx(h, l, c, n = 14) {
      const len = c.length;
      const pdm = nanArr(len), mdm = nanArr(len);
      for (let i = 1; i < len; i++) {
        const up = h[i] - h[i - 1], dn = l[i - 1] - l[i];
        pdm[i] = up > dn && up > 0 ? up : 0;
        mdm[i] = dn > up && dn > 0 ? dn : 0;
      }
      const tr = ind.trueRange(h, l, c);
      tr[0] = NaN;
      const str = rma(tr, n), sp = rma(pdm, n), sm = rma(mdm, n);
      const pdi = str.map((t, i) => (t > 0 ? (100 * sp[i]) / t : NaN));
      const mdi = str.map((t, i) => (t > 0 ? (100 * sm[i]) / t : NaN));
      const dx = pdi.map((p, i) => (p + mdi[i] > 0 ? (100 * Math.abs(p - mdi[i])) / (p + mdi[i]) : NaN));
      return { adx: rma(dx, n), pdi, mdi };
    },

    obv(c, v) {
      const out = nanArr(c.length);
      out[0] = 0;
      for (let i = 1; i < c.length; i++) {
        const vol = fin(v[i]) ? v[i] : 0;
        out[i] = out[i - 1] + (c[i] > c[i - 1] ? vol : c[i] < c[i - 1] ? -vol : 0);
      }
      return out;
    },

    // Close location value: +1 = closed at the high, −1 = at the low.
    clv(h, l, c) {
      return c.map((x, i) => (h[i] - l[i] > 0 ? ((x - l[i]) - (h[i] - x)) / (h[i] - l[i]) : 0));
    },

    // Chaikin money flow; without volume this degrades to the average close location.
    cmf(h, l, c, v, n = 20, hasVolume = true) {
      const m = ind.clv(h, l, c);
      if (!hasVolume) return sma(m, n);
      const out = nanArr(c.length);
      for (let i = n - 1; i < c.length; i++) {
        let num = 0, den = 0;
        for (let j = i - n + 1; j <= i; j++) { num += m[j] * v[j]; den += v[j]; }
        out[i] = den > 0 ? num / den : NaN;
      }
      return out;
    },

    mfi(h, l, c, v, n = 14) {
      const tp = c.map((x, i) => (h[i] + l[i] + x) / 3);
      const out = nanArr(c.length);
      for (let i = n; i < c.length; i++) {
        let pos = 0, neg = 0;
        for (let j = i - n + 1; j <= i; j++) {
          const f = tp[j] * v[j];
          if (tp[j] > tp[j - 1]) pos += f; else if (tp[j] < tp[j - 1]) neg += f;
        }
        out[i] = neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
      }
      return out;
    },

    // Rolling VWAP over n bars from typical price; without volume, typical-price SMA.
    vwap(h, l, c, v, n = 20, hasVolume = true) {
      const tp = c.map((x, i) => (h[i] + l[i] + x) / 3);
      if (!hasVolume) return sma(tp, n);
      const out = nanArr(c.length);
      for (let i = n - 1; i < c.length; i++) {
        let num = 0, den = 0;
        for (let j = i - n + 1; j <= i; j++) { num += tp[j] * v[j]; den += v[j]; }
        out[i] = den > 0 ? num / den : NaN;
      }
      return out;
    },

    // z-score of log volume against its n-day mean.
    volumeZ(v, n = 20) {
      const lv = v.map(x => (x > 0 ? Math.log(x) : NaN));
      const m = sma(lv, n), s = rstd(lv, n);
      return lv.map((x, i) => (s[i] > 0 ? (x - m[i]) / s[i] : NaN));
    },

    rollSkew(r, n) {
      const out = nanArr(r.length);
      for (let i = n; i < r.length; i++) {
        let s = 0;
        for (let j = i - n + 1; j <= i; j++) s += r[j];
        const m = s / n;
        let m2 = 0, m3 = 0;
        for (let j = i - n + 1; j <= i; j++) { const d = r[j] - m; m2 += d * d; m3 += d * d * d; }
        m2 /= n; m3 /= n;
        out[i] = m2 > 0 ? m3 / Math.pow(m2, 1.5) : 0;
      }
      return out;
    },

    downsideDev(r, n) {
      const out = nanArr(r.length);
      for (let i = n; i < r.length; i++) {
        let s = 0;
        for (let j = i - n + 1; j <= i; j++) s += Math.min(0, r[j]) ** 2;
        out[i] = Math.sqrt(s / n);
      }
      return out;
    },

    // Annualised Sortino ratio over n days.
    sortino(r, n) {
      const dd = ind.downsideDev(r, n), m = sma(r, n);
      return m.map((x, i) => (dd[i] > 0 ? (x / dd[i]) * Math.sqrt(252) : NaN));
    },
  };

  // ── Bars + per-symbol feature cache ────────────────────────────────────────
  // Accepts bars as { o, h, l, c, v } arrays, an array of { o, h, l, c, v } objects (the
  // /api/bars shape), or a plain array of closes (no OHLC: open = previous close).
  function normalizeBars(input) {
    if (Array.isArray(input) && typeof input[0] === 'number') {
      const c = input.slice();
      const o = c.map((x, i) => (i ? c[i - 1] : x));
      return { o, h: c.map((x, i) => Math.max(x, o[i])), l: c.map((x, i) => Math.min(x, o[i])), c, v: c.map(() => NaN), t: null };
    }
    if (Array.isArray(input)) {
      const pick = (k, alt) => input.map(b => (fin(+b[k]) ? +b[k] : alt(b)));
      const c = pick('c', () => NaN);
      const o = pick('o', b => +b.c);
      return {
        o, c,
        h: pick('h', b => Math.max(+b.o || +b.c, +b.c)),
        l: pick('l', b => Math.min(+b.o || +b.c, +b.c)),
        v: input.map(b => (fin(+b.v) ? +b.v : NaN)),
        t: input.map(b => b.t || null),
      };
    }
    return { o: input.o, h: input.h, l: input.l, c: input.c, v: input.v || input.c.map(() => NaN), t: input.t || null };
  }

  // Memoised indicator access: every agent asks for what it needs, computed once per symbol.
  function makeFeatures(rawBars) {
    const b = normalizeBars(rawBars);
    const n = b.c.length;
    const volOk = b.v.filter(x => fin(x) && x > 0).length;
    const memo = new Map();
    const m = (key, fn) => { if (!memo.has(key)) memo.set(key, fn()); return memo.get(key); };
    const F = {
      n, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, t: b.t,
      hasVolume: n > 0 && volOk / n >= 0.8,
      ret:     ()             => m('ret', () => ind.returns(b.c)),
      rN:      (k)            => m(`rN:${k}`, () => ind.nDayReturn(b.c, k)),
      sma:     (k)            => m(`sma:${k}`, () => sma(b.c, k)),
      ema:     (k)            => m(`ema:${k}`, () => ema(b.c, k)),
      bb:      (k = 20, s = 2) => m(`bb:${k}:${s}`, () => ind.bollinger(b.c, k, s)),
      atr:     (k = 14)       => m(`atr:${k}`, () => ind.atr(b.h, b.l, b.c, k)),
      atrPct:  (k = 14)       => m(`atrPct:${k}`, () => F.atr(k).map((a, i) => a / b.c[i])),
      atrRank: (k = 14, look = 120) => m(`atrRank:${k}:${look}`, () => pctRank(F.atrPct(k), look)),
      kc:      (k = 20, mult = 1.5) => m(`kc:${k}:${mult}`, () => ind.keltner(b.h, b.l, b.c, k, mult)),
      rsi:     (k = 14)       => m(`rsi:${k}`, () => ind.rsi(b.c, k)),
      macd:    (f = 12, s = 26, g = 9) => m(`macd:${f}:${s}:${g}`, () => ind.macd(b.c, f, s, g)),
      adx:     (k = 14)       => m(`adx:${k}`, () => ind.adx(b.h, b.l, b.c, k)),
      stoch:   (k = 14, d = 3) => m(`stoch:${k}:${d}`, () => ind.stochastic(b.h, b.l, b.c, k, d)),
      donHi:   (k = 20)       => m(`donHi:${k}`, () => rollMax(b.h, k, true)),
      donLo:   (k = 20)       => m(`donLo:${k}`, () => rollMin(b.l, k, true)),
      obv:     ()             => m('obv', () => ind.obv(b.c, b.v)),
      cmf:     (k = 20)       => m(`cmf:${k}`, () => ind.cmf(b.h, b.l, b.c, b.v, k, F.hasVolume)),
      mfi:     (k = 14)       => m(`mfi:${k}`, () => ind.mfi(b.h, b.l, b.c, b.v, k)),
      vwap:    (k = 20)       => m(`vwap:${k}`, () => ind.vwap(b.h, b.l, b.c, b.v, k, F.hasVolume)),
      volZ:    (k = 20)       => m(`volZ:${k}`, () => ind.volumeZ(b.v, k)),
      skew:    (k = 20)       => m(`skew:${k}`, () => ind.rollSkew(F.ret(), k)),
      ddev:    (k = 20)       => m(`ddev:${k}`, () => ind.downsideDev(F.ret(), k)),
      sortino: (k = 60)       => m(`sortino:${k}`, () => ind.sortino(F.ret(), k)),
      bwRank:  (k = 20, s = 2, look = 120) => m(`bwRank:${k}:${s}:${look}`, () => pctRank(F.bb(k, s).bw, look)),
      tr:      ()             => m('tr', () => ind.trueRange(b.h, b.l, b.c)),
      clv:     ()             => m('clv', () => ind.clv(b.h, b.l, b.c)),
      vol:     (k = 20)       => m(`vol:${k}`, () => rstd(F.ret(), k).map(s => s * Math.sqrt(252))),
    };
    return F;
  }

  // ── Regime ─────────────────────────────────────────────────────────────────
  // Trend vs range from ADX; calm vs volatile from where today's ATR% sits in its last 120 days.
  const REGIME_KEYS = ['trend-calm', 'trend-volatile', 'range-calm', 'range-volatile'];
  const REGIME_LABELS = {
    'trend-calm': 'Trend · calm', 'trend-volatile': 'Trend · volatile',
    'range-calm': 'Range · calm', 'range-volatile': 'Range · volatile',
  };

  function regimeAt(F, i, opts = {}) {
    const adxMin = opts.adxTrend ?? 22, volRank = opts.volRank ?? 0.7;
    const a = F.adx(14).adx[i], r = F.atrRank(14, 120)[i];
    const trend = fin(a) ? a >= adxMin : false;
    const volatile = fin(r) ? r >= volRank : false;
    const key = `${trend ? 'trend' : 'range'}-${volatile ? 'volatile' : 'calm'}`;
    return { key, label: REGIME_LABELS[key], trend, volatile, adx: a, atrRank: r };
  }

  // ── Universe: features for every symbol + cross-sectional context ──────────
  // Symbols are aligned on their last bar (global index g = local index + offset).
  function buildUniverse(barsBySym, sectorOf = {}) {
    const syms = Object.keys(barsBySym).filter(s => barsBySym[s] && (barsBySym[s].c || barsBySym[s]).length > 0);
    const F = {}, off = {};
    for (const s of syms) F[s] = makeFeatures(barsBySym[s]);
    const L = Math.max(0, ...syms.map(s => F[s].n));
    for (const s of syms) off[s] = L - F[s].n;

    // Market context by global index
    const breadth50 = nanArr(L), breadth200 = nanArr(L), mktRet = nanArr(L);
    const sectorR20 = {}, sectorR1 = {};
    const sectors = [...new Set(syms.map(s => sectorOf[s] || 'Other'))];
    for (const sec of sectors) { sectorR20[sec] = { sum: new Array(L).fill(0), cnt: new Array(L).fill(0) }; sectorR1[sec] = { sum: new Array(L).fill(0), cnt: new Array(L).fill(0) }; }
    for (let g = 0; g < L; g++) {
      let a50 = 0, n50 = 0, a200 = 0, n200 = 0, rs = 0, nr = 0;
      for (const s of syms) {
        const i = g - off[s];
        if (i < 0) continue;
        const f = F[s], c = f.c[i];
        const m50 = f.sma(50)[i], m200 = f.sma(200)[i], r = f.ret()[i], r20 = f.rN(20)[i];
        if (fin(m50)) { n50++; if (c > m50) a50++; }
        if (fin(m200)) { n200++; if (c > m200) a200++; }
        if (fin(r)) { rs += r; nr++; }
        const sec = sectorOf[s] || 'Other';
        if (fin(r20)) { sectorR20[sec].sum[g] += r20; sectorR20[sec].cnt[g]++; }
        if (fin(r)) { sectorR1[sec].sum[g] += r; sectorR1[sec].cnt[g]++; }
      }
      if (n50 >= Math.max(3, syms.length * 0.5)) breadth50[g] = a50 / n50;
      if (n200 >= Math.max(3, syms.length * 0.5)) breadth200[g] = a200 / n200;
      if (nr) mktRet[g] = rs / nr;
    }
    // Equal-weight index level and its 50-day average
    const mktIdx = nanArr(L);
    let lvl = 100;
    for (let g = 0; g < L; g++) { if (fin(mktRet[g])) lvl *= 1 + mktRet[g]; mktIdx[g] = lvl; }
    const mktSma50 = sma(mktIdx, 50);

    return { syms, F, off, L, sectorOf, ctx: { breadth50, breadth200, mktRet, mktIdx, mktSma50, sectorR20, sectorR1 }, pairCache: {} };
  }

  // Most-correlated same-sector peer over the last `look` bars, re-picked every 20 bars.
  function pairFor(U, sym, i, look = 120) {
    const g = i + U.off[sym];
    const bucket = Math.floor(g / 20);
    const key = `${sym}:${bucket}:${look}`;
    if (key in U.pairCache) return U.pairCache[key];
    const sec = U.sectorOf[sym] || 'Other';
    const fa = U.F[sym], ra = fa.ret();
    let best = null;
    const gEnd = bucket * 20; // choose with data up to the bucket start: stable within the bucket, no lookahead
    for (const p of U.syms) {
      if (p === sym || (U.sectorOf[p] || 'Other') !== sec) continue;
      const fb = U.F[p], rb = fb.ret();
      let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, n = 0;
      for (let gg = gEnd - look + 1; gg <= gEnd; gg++) {
        const ia = gg - U.off[sym], ib = gg - U.off[p];
        if (ia < 1 || ib < 1 || !fin(ra[ia]) || !fin(rb[ib])) continue;
        sa += ra[ia]; sb += rb[ib]; saa += ra[ia] ** 2; sbb += rb[ib] ** 2; sab += ra[ia] * rb[ib]; n++;
      }
      if (n < look * 0.8) continue;
      const cov = sab / n - (sa / n) * (sb / n);
      const va = saa / n - (sa / n) ** 2, vb = sbb / n - (sb / n) ** 2;
      const corr = va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0;
      if (!best || corr > best.corr) best = { peer: p, corr };
    }
    U.pairCache[key] = best;
    return best;
  }

  // ── Agents ─────────────────────────────────────────────────────────────────
  // Nine agents, each built on a method with long-run evidence (see DIRECTION.md). Seven stock pickers rank
  // every stock against the others each day; Market trend times the whole market; Risk guardian only ever
  // says SELL (danger) or nothing. Each agent has:
  //   AGENT_RAW[id](F, i, U, sym)  its continuous reading (positive = good for the stock), every day
  //   AGENT_FNS[id](F, i, P, U, sym)  its vote { dir, strength, note }: pickers vote BUY when the stock is in
  //       the top `band` of today's ranking and SELL in the bottom `band` (strength = how far out); otherwise
  //       no view. Rankings are across the stocks that have a reading that day, cached per universe and day.
  const DEFAULT_PARAMS = {
    mom:      { lookback: 252, skip: 21, band: 0.3 },        // 12-month return excluding the last month, risk-adjusted
    hi52:     { window: 252, band: 0.3 },                     // price relative to its 52-week high
    sect:     { lookback: 126, band: 0.3 },                   // the stock's sector trend vs the market
    rev:      { window: 10, band: 0.3 },                      // last 2 weeks vs sector peers, faded
    lowvol:   { window: 120, band: 0.3 },                     // calm stocks over the last ~6 months
    volshock: { short: 5, long: 60, band: 0.3 },              // abnormal trading volume (high-volume premium)
    drift:    { gapAtr: 1.0, volZ: 1.5, window: 20, band: 0.3 }, // big gap on heavy volume, then follow-through
    mkt:      { sma: 200, thr: 0.2 },                         // index vs its 200-day average and 12-month trend
    risk:     { volRatio: 1.6, crashSigma: 3.5, ddLimit: 0.15 }, // volatility jumps, crash days, drawdowns
  };
  const AGENT_IDS = Object.keys(DEFAULT_PARAMS);
  const PICKERS = ['mom', 'hi52', 'sect', 'rev', 'lowvol', 'volshock', 'drift'];
  const AGENT_ROLE = { mkt: 'timing', risk: 'risk' };
  const roleOf = (id) => AGENT_ROLE[id] || 'picker';
  // The trend score behind Rank & tilt (6-month return skipping the last month) is kept as its own setting
  const TREND_PARAMS = { lookback: 126, skip: 21 };

  const NEUTRAL = Object.freeze({ dir: 0, strength: 0, note: 'no view' });
  const sig = (dir, strength, note) => (dir && strength > 0.02 ? { dir, strength: +strength.toFixed(3), note } : { dir: 0, strength: 0, note: note || 'no view' });
  const sign = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);
  const pct = (x) => `${(x * 100).toFixed(1)}%`;

  // Per-universe helpers (cached on U): sector average of an N-day return at global day g, market index SMA
  function xsCache(U) { return U._xs || (U._xs = new Map()); }
  function sectorMean(U, n, g, sec) {
    const key = `sec:${n}:${g}`, c = xsCache(U);
    if (!c.has(key)) {
      const sums = {}, cnt = {};
      let all = 0, nAll = 0;
      for (const s of U.syms) {
        const F = U.F[s], i = g - U.off[s];
        if (i < n) continue;
        const r = F.c[i] / F.c[i - n] - 1;
        if (!fin(r)) continue;
        const k = (U.sectorOf && U.sectorOf[s]) || 'Other';
        sums[k] = (sums[k] || 0) + r; cnt[k] = (cnt[k] || 0) + 1; all += r; nAll++;
      }
      const m = { _all: nAll ? all / nAll : NaN, _n: nAll };
      for (const k of Object.keys(sums)) m[k] = { mean: sums[k] / cnt[k], n: cnt[k] };
      c.set(key, m);
    }
    const m = c.get(key);
    return { sector: m[sec] || null, market: m._all, n: m._n };
  }
  function mktSma(U, n) {
    const key = `mktsma:${n}`, c = xsCache(U);
    if (!c.has(key)) c.set(key, sma(U.ctx.mktIdx, n));
    return c.get(key);
  }

  const AGENT_RAW = {
    // Momentum: return from 12 months ago to 1 month ago, divided by volatility
    mom(F, i, U, sym, p = DEFAULT_PARAMS.mom) {
      const lb = Math.min(p.lookback, i - 1);
      if (lb < 126) return NaN;
      const r = F.c[i - p.skip] / F.c[i - lb] - 1, vol = F.vol(lb)[i];
      return fin(r) && vol > 0 ? r / (vol * Math.sqrt((lb - p.skip) / 252)) : NaN;
    },
    // 52-week high: close as a share of the highest high in the window (1 = at the high)
    hi52(F, i, U, sym, p = DEFAULT_PARAMS.hi52) {
      const w = Math.min(p.window, i + 1);
      if (w < 126) return NaN;
      let hi = -Infinity; for (let j = i - w + 1; j <= i; j++) if (F.h[j] > hi) hi = F.h[j];
      return hi > 0 ? F.c[i] / hi : NaN;
    },
    // Sector strength: the stock's sector average return over ~6 months minus the market's
    sect(F, i, U, sym, p = DEFAULT_PARAMS.sect) {
      if (!U || i < p.lookback) return NaN;
      const g = i + U.off[sym], m = sectorMean(U, p.lookback, g, (U.sectorOf && U.sectorOf[sym]) || 'Other');
      return m.sector && m.sector.n >= 2 && fin(m.market) ? m.sector.mean - m.market : NaN;
    },
    // Short-term reversal: minus the stock's last-2-weeks return relative to its sector (or the market)
    rev(F, i, U, sym, p = DEFAULT_PARAMS.rev) {
      if (i < p.window) return NaN;
      const r = F.c[i] / F.c[i - p.window] - 1;
      if (!U) return -r;
      const g = i + U.off[sym], m = sectorMean(U, p.window, g, (U.sectorOf && U.sectorOf[sym]) || 'Other');
      const peer = m.sector && m.sector.n >= 3 ? (m.sector.mean * m.sector.n - r) / (m.sector.n - 1) : m.market;
      return fin(r) && fin(peer) ? -(r - peer) : NaN;
    },
    // Low volatility: minus annualised volatility over ~6 months
    lowvol(F, i, U, sym, p = DEFAULT_PARAMS.lowvol) {
      if (i < Math.min(p.window, 60)) return NaN;
      const v = F.vol(Math.min(p.window, i))[i];
      return v > 0 ? -v : NaN;
    },
    // Volume shock: log of last week's average volume over the previous ~3 months' (no volume → no view)
    volshock(F, i, U, sym, p = DEFAULT_PARAMS.volshock) {
      if (!F.hasVolume || i < p.long + p.short) return NaN;
      let a = 0, b = 0;
      for (let j = i - p.short + 1; j <= i; j++) a += F.v[j];
      for (let j = i - p.short - p.long + 1; j <= i - p.short; j++) b += F.v[j];
      a /= p.short; b /= p.long;
      return a > 0 && b > 0 ? Math.log(a / b) : NaN;
    },
    // News drift: the biggest gap (≥ gapAtr ATR) on heavy volume in the last `window` days, signed, scaled
    // by how much of it has held and fading with age; 0 when there's none
    drift(F, i, U, sym, p = DEFAULT_PARAMS.drift) {
      const atr = F.atr(14), vz = F.hasVolume ? F.volZ(20) : null;
      if (i < p.window + 15) return NaN;
      let best = 0;
      for (let j = i - p.window + 1; j <= i; j++) {
        if (!fin(atr[j - 1]) || !(atr[j - 1] > 0)) continue;
        const gap = (F.o[j] - F.c[j - 1]) / atr[j - 1];
        if (Math.abs(gap) < p.gapAtr) continue;
        if (vz && !(fin(vz[j]) && vz[j] >= p.volZ)) continue;
        const held = (F.c[i] - F.c[j - 1]) / (F.o[j] - F.c[j - 1]); // 1 = still at the gap, ≤0 = fully filled
        if (held <= 0.25) continue;
        const v = Math.sign(gap) * Math.min(4, Math.abs(gap)) * Math.min(1.5, held) * (1 - (i - j) / (p.window + 5));
        if (Math.abs(v) > Math.abs(best)) best = v;
      }
      return best;
    },
    // Market trend: equal-weight index vs its 200-day average, and its 12-month trend (same for every stock)
    mkt(F, i, U, sym, p = DEFAULT_PARAMS.mkt) {
      if (!U) return NaN;
      const g = i + U.off[sym], idx = U.ctx.mktIdx, s = mktSma(U, p.sma)[g];
      if (!fin(idx[g]) || !fin(s) || g < 252) return NaN;
      return 0.5 * Math.tanh((idx[g] / s - 1) / 0.05) + 0.5 * Math.tanh((idx[g] / idx[g - 252] - 1) / 0.2);
    },
    // Risk guardian: danger reading (negative = danger) from a volatility jump, a crash day or a deep drop
    risk(F, i, U, sym, p = DEFAULT_PARAMS.risk) {
      if (i < 130) return NaN;
      const v20 = F.vol(20)[i], v120 = F.vol(120)[i], r1 = F.c[i] / F.c[i - 1] - 1;
      let hi = -Infinity; for (let j = i - 19; j <= i; j++) if (F.c[j] > hi) hi = F.c[j];
      if (!(v20 > 0) || !(v120 > 0)) return NaN;
      const jump = Math.max(0, v20 / v120 / p.volRatio - 1) * 2;
      const crash = Math.max(0, -r1 / (v120 / Math.sqrt(252)) / p.crashSigma - 0.5);
      const dd = Math.max(0, (1 - F.c[i] / hi) / p.ddLimit - 0.5);
      return -(jump + crash + dd);
    },
  };

  // Today's ranking of a picker's readings across the universe: rank in [0, 1] per symbol (cached)
  function pickerRanks(U, id, g, P) {
    const key = `rank:${id}:${g}:${JSON.stringify(P || '')}`, c = xsCache(U);
    if (c.has(key)) return c.get(key);
    const vals = [];
    for (const s of U.syms) {
      const i = g - U.off[s];
      if (i < 1) continue;
      let v; try { v = AGENT_RAW[id](U.F[s], i, U, s, P); } catch (e) { v = NaN; }
      if (fin(v)) vals.push([s, v]);
    }
    vals.sort((a, b) => a[1] - b[1]);
    const ranks = new Map();
    if (vals.length >= 3) {
      // ties share their average rank
      let k = 0;
      while (k < vals.length) {
        let e = k; while (e + 1 < vals.length && vals[e + 1][1] === vals[k][1]) e++;
        const r = ((k + e) / 2) / (vals.length - 1);
        for (let q = k; q <= e; q++) ranks.set(vals[q][0], r);
        k = e + 1;
      }
    }
    c.set(key, ranks);
    return ranks;
  }
  const PICKER_TEXT = {
    mom: (v) => `12-month momentum ${v.toFixed(2)} (risk-adjusted)`, hi52: (v) => `${pct(v)} of its 52-week high`,
    sect: (v) => `sector ${v >= 0 ? '+' : ''}${pct(v)} vs market (6 months)`, rev: (v) => `${pct(-v)} vs sector peers (2 weeks)`,
    lowvol: (v) => `volatility ${pct(-v)} a year`, volshock: (v) => `volume ${Math.exp(v).toFixed(1)}× normal`,
    drift: (v) => (v ? `${v > 0 ? 'up' : 'down'} gap on heavy volume holding` : 'no recent news gap'),
  };
  function pickerVote(id, F, i, P, U, sym) {
    if (!U) return NEUTRAL;
    const g = i + U.off[sym], ranks = pickerRanks(U, id, g, P), r = ranks.get(sym);
    if (r == null) return NEUTRAL;
    let raw; try { raw = AGENT_RAW[id](F, i, U, sym, P); } catch (e) { raw = NaN; }
    if (id === 'drift' && !raw) return sig(0, 0, PICKER_TEXT.drift(0));
    const band = P.band ?? 0.3, note = `${PICKER_TEXT[id](raw)} · rank ${Math.round(r * 100)}%`;
    if (r >= 1 - band) return sig(1, (r - (1 - band)) / band * 0.7 + 0.3, note);
    if (r <= band) return sig(-1, (band - r) / band * 0.7 + 0.3, note);
    return sig(0, 0, note);
  }
  const AGENT_FNS = {
    mom: (F, i, P, U, sym) => pickerVote('mom', F, i, P, U, sym),
    hi52: (F, i, P, U, sym) => pickerVote('hi52', F, i, P, U, sym),
    sect: (F, i, P, U, sym) => pickerVote('sect', F, i, P, U, sym),
    rev: (F, i, P, U, sym) => pickerVote('rev', F, i, P, U, sym),
    lowvol: (F, i, P, U, sym) => pickerVote('lowvol', F, i, P, U, sym),
    volshock: (F, i, P, U, sym) => pickerVote('volshock', F, i, P, U, sym),
    drift: (F, i, P, U, sym) => pickerVote('drift', F, i, P, U, sym),
    mkt(F, i, P, U, sym) {
      const v = AGENT_RAW.mkt(F, i, U, sym, P);
      if (!fin(v)) return NEUTRAL;
      const note = `market trend ${v >= 0 ? '+' : ''}${v.toFixed(2)} (index vs ${P.sma}-day average, 12-month trend)`;
      return Math.abs(v) >= P.thr ? sig(sign(v), Math.min(1, Math.abs(v)), note) : sig(0, 0, note);
    },
    risk(F, i, P, U, sym) {
      const v = AGENT_RAW.risk(F, i, U, sym, P);
      if (!fin(v)) return NEUTRAL;
      return v < 0 ? sig(-1, Math.min(1, -v), `danger ${(-v).toFixed(2)}: volatility jump, crash day or deep drop`) : sig(0, 0, 'no danger signs');
    },
  };

  function agentReadings(U, sym, i, params) {
    const F = U.F[sym];
    if (!F || i == null || i < 60) return null;
    const P = mergeParams(params), out = {};
    for (const id of AGENT_IDS) { let v; try { v = AGENT_RAW[id](F, i, U, sym, P[id]); } catch (e) { v = NaN; } out[id] = fin(v) ? v : NaN; }
    return out;
  }

  // The team decision for one stock from its nine votes:
  //   BUY  (not held) when at least `minVotes` of the 7 pickers vote BUY, the weighted picker score is at
  //        least `minConf`, the market trend isn't strongly negative and the risk guardian sees no danger;
  //   SELL (held) when at least `minVotes` pickers vote SELL, or the risk guardian's danger is ≥ riskExit;
  //   otherwise HOLD (held) or WAIT (not held). A tie can't be a majority: 7 voters, abstentions allowed.
  const DECISION = { minVotes: 4, minConf: 0.25, riskExit: 1.0, fill: false };
  function teamDecision(signals, { weights = null, held = false, ...o } = {}) {
    const d = { ...DECISION, ...o };
    let fv = 0, av = 0, sw = 0, ws = 0;
    const votes = {};
    for (const id of PICKERS) {
      const s = signals && signals[id], w = weights ? (weights[id] ?? 0) : 1;
      votes[id] = s ? s.dir : 0;
      ws += w; // abstaining counts as a view of 0: the collective confidence of all seven
      if (!s || !s.dir) continue;
      if (s.dir > 0) fv++; else av++;
      sw += w * s.dir * s.strength;
    }
    const score = ws > 0 ? sw / ws : 0;
    const mkt = signals && signals.mkt ? signals.mkt.dir * signals.mkt.strength : 0;
    const danger = signals && signals.risk && signals.risk.dir < 0 ? signals.risk.strength : 0;
    let action, why;
    if (held) {
      if (danger >= d.riskExit) { action = 'SELL'; why = `risk guardian: danger ${danger.toFixed(2)}`; }
      else if (av >= d.minVotes) { action = 'SELL'; why = `${av} of 7 pickers say sell`; }
      else { action = 'HOLD'; why = `${fv} for, ${av} against: no majority to sell`; }
    } else if ((fv >= d.minVotes && score >= d.minConf || d.fill && score > 0 && fv > av) && danger < d.riskExit && mkt > -0.6) {
      action = 'BUY'; why = `${fv} of 7 pickers say buy (score ${score.toFixed(2)})`;
    } else {
      action = 'WAIT';
      why = fv >= d.minVotes ? (danger >= d.riskExit ? 'majority to buy, but the risk guardian objects' : mkt <= -0.6 ? 'majority to buy, but the market trend is strongly down' : `majority to buy, but confidence ${score.toFixed(2)} < ${d.minConf}`)
        : `${fv} for, ${av} against: no majority to buy`;
    }
    return { action, why, forVotes: fv, againstVotes: av, abstain: PICKERS.length - fv - av, score, confidence: Math.abs(score), p: 0.5 + score / 2, mkt, danger, votes };
  }

  function mergeParams(user = {}) {
    const out = {};
    for (const id of AGENT_IDS) out[id] = { ...DEFAULT_PARAMS[id], ...(user[id] || {}) };
    return out;
  }

  // All 16 agents for one symbol at local bar index i (default: the last bar).
  function agentSignals(U, sym, i, params) {
    const F = U.F[sym];
    if (!F) return null;
    if (i == null) i = F.n - 1;
    if (i < 60) return null;
    const P = mergeParams(params);
    const out = {};
    for (const id of AGENT_IDS) {
      try { out[id] = AGENT_FNS[id](F, i, P[id], U, sym) || NEUTRAL; }
      catch (e) { out[id] = NEUTRAL; }
    }
    return out;
  }

  // ── Ensemble ───────────────────────────────────────────────────────────────
  // weights: { id: w }. opts.enabled: Set of ids. opts.regimeMult / opts.corrAdj: { id: multiplier }.
  // confidence = agreement among voters × how much of the swarm's weight is actually voting,
  // so one lukewarm agent can no longer produce a 95% confident trade.
  function ensemble(signals, weights, opts = {}) {
    const ids = opts.ids || AGENT_IDS;
    let dirSum = 0, voteW = 0, totalW = 0;
    const votes = {};
    for (const id of ids) {
      if (opts.enabled && !opts.enabled.has(id)) { votes[id] = 0; continue; }
      const s = signals && signals[id];
      const w = (weights[id] ?? 1 / ids.length) * (opts.regimeMult?.[id] ?? 1) * (opts.corrAdj?.[id] ?? 1);
      totalW += w;
      votes[id] = s ? s.dir : 0;
      if (s && s.dir) { dirSum += s.dir * s.strength * w; voteW += s.strength * w; }
    }
    const agreement = voteW > 0 ? dirSum / voteW : 0;
    const participation = totalW > 0 ? voteW / totalW : 0;
    const net = agreement * Math.min(1, Math.sqrt(participation / 0.25));
    const dir = net > 0.05 ? 'BUY' : net < -0.05 ? 'SELL' : null;
    const confidence = Math.min(0.97, Math.abs(net));
    const consensus = dir ? ids.filter(id => votes[id] === (dir === 'BUY' ? 1 : -1)).length : 0;
    const vArr = ids.map(id => votes[id] || 0);
    const vMean = vArr.reduce((s, v) => s + v, 0) / vArr.length;
    const disagreement = Math.min(1, Math.sqrt(vArr.reduce((s, v) => s + (v - vMean) ** 2, 0) / vArr.length));
    return { dir, confidence, consensus, votes, disagreement, agreement, participation };
  }

  // Down-weight agents that vote alike: multiplier ∝ 1 / Σ_j max(0, ρ_ij), normalised to mean 1.
  // rows: array of { id: vote }, ideally every agent's vote on every ticker over recent days.
  function correlationAdjust(rows, ids = AGENT_IDS, minRows = 30) {
    const out = {};
    ids.forEach(id => { out[id] = 1; });
    if (!rows || rows.length < minRows) return out;
    const X = ids.map(id => rows.map(r => r[id] || 0));
    const mu = X.map(x => x.reduce((s, v) => s + v, 0) / x.length);
    const sd = X.map((x, k) => Math.sqrt(x.reduce((s, v) => s + (v - mu[k]) ** 2, 0) / x.length));
    const live = ids.map((_, k) => sd[k] > 0);
    const raw = ids.map((_, a) => {
      if (!live[a]) return null;
      let sum = 0;
      for (let b = 0; b < ids.length; b++) {
        if (!live[b]) continue;
        let cov = 0;
        for (let t = 0; t < rows.length; t++) cov += (X[a][t] - mu[a]) * (X[b][t] - mu[b]);
        sum += Math.max(0, cov / rows.length / (sd[a] * sd[b]));
      }
      return 1 / Math.max(1, sum);
    });
    const vals = raw.filter(v => v != null);
    const mean = vals.reduce((s, v) => s + v, 0) / (vals.length || 1);
    // applied at half strength: the penalty corrects double-counting without silencing an agent
    ids.forEach((id, k) => { out[id] = raw[k] != null ? clamp(0.5 + 0.5 * (raw[k] / mean), 0.5, 1.5) : 1; });
    return out;
  }

  // Per-regime accuracy → weight multiplier in 0.6..1.4. Neutral until an agent has 15 closed votes in
  // the regime, then shrunk toward 50% with 12 pseudo-wins and 12 pseudo-losses, because small samples
  // of trade outcomes are mostly noise.
  function regimeMultipliers(hist = {}, ids = AGENT_IDS) {
    const out = {};
    for (const id of ids) {
      const h = hist[id] || [];
      if (h.length < 15) { out[id] = 1; continue; }
      const wins = h.filter(Boolean).length;
      const acc = (wins + 12) / (h.length + 24);
      out[id] = clamp(1 + 2 * (acc - 0.5), 0.6, 1.4);
    }
    return out;
  }

  // ATR stop / target distances (as fractions of price) and risk-based position size.
  function atrPlan({ price, atr, equity, riskPct = 1.1, maxTradePct = 5, atrStop = 2, atrTarget = 3, confidence = 0.5 }) {
    const stopPct = (atrStop * atr) / price, tpPct = (atrTarget * atr) / price;
    if (!(stopPct > 0)) return null;
    const riskBudget = equity * (riskPct / 100);
    const base = Math.min(equity * (maxTradePct / 100), riskBudget / stopPct);
    return { stopPct, tpPct, notional: base * (0.5 + 0.5 * clamp(confidence, 0, 1)) };
  }

  // ── Trading costs ──────────────────────────────────────────────────────────
  // One number per trade side, in basis points: half the bid/ask spread + slippage + commission.
  // Engines buy at price × (1 + cost) and sell at price × (1 − cost).
  const COST_PROFILES = {
    alpaca:    { label: 'Alpaca (no commission)', bps: 5 },   // ~2bp half-spread on large caps + ~3bp slippage
    ig:        { label: 'IG spread bet',          bps: 12 },  // wider quoted spread on US share spread bets
    fictional: { label: 'Fictional market',       bps: 5 },
  };
  const costOf = (o) => (o.costBps != null ? o.costBps / 1e4 : (o.slip ?? 0.0005));

  // ── Rank & tilt ────────────────────────────────────────────────────────────
  // Fully invested in the top-K stocks by a score, re-ranked at each month end (decision at the last
  // close of the month, trades at the next open). Swap-only: dropped names are sold, new names bought
  // with an equal share of equity; holdings that stay are not resized, keeping turnover and costs low.
  // Default score: the trend score (return from 6 months ago to 1 month ago).
  function trendScore(F, i, p = TREND_PARAMS) {
    const lb = p.lookback ?? 126, skip = p.skip ?? 21;
    return i >= lb ? F.c[i - skip] / F.c[i - lb] - 1 : NaN;
  }

  // Crash guard signal: the universe's equal-weight index below its n-day average
  function marketBelowAverage(U, n = 200) {
    const sma = ind.sma(U.ctx.mktIdx, n);
    return (g) => fin(sma[g]) && U.ctx.mktIdx[g] < sma[g];
  }

  function monthEnd(U, g) {
    for (const s of U.syms) {
      const F = U.F[s], i = g - U.off[s];
      if (F.t && F.t[i] && F.t[i + 1]) return String(F.t[i]).slice(0, 7) !== String(F.t[i + 1]).slice(0, 7);
      if (F.t && F.t[i] && !F.t[i + 1]) return false;
    }
    return null; // no dates: caller falls back to every 21 bars
  }

  // Holding at least as many stocks as exist would just be buy-and-hold: fall back to the top half
  const effectiveTopK = (topK, N) => (topK && topK < N ? Math.max(1, topK) : Math.max(1, Math.ceil(N / 2)));

  // The 9-agent team traded day by day with the same rule the server engine uses: decide at each close
  // (teamDecision on every stock: SELL holdings the majority or the risk guardian turns against, BUY new
  // names a majority backs with enough confidence, best scores first), trade at the next open, at most
  // maxPos positions of equity × investFraction / maxPos each (halved while the market trend is negative),
  // costs on every buy and sell. Decisions use only bars up to that close.
  function runTeam(U, o = {}) {
    const start = Math.max(o.start ?? 260, 130), end = Math.min(o.end ?? U.L - 1, U.L - 1);
    const capital = o.capital ?? 100000, cost = costOf(o), frac = o.investFraction ?? 0.9;
    const maxPos = Math.max(1, Math.min(o.maxPos ?? 12, U.syms.length));
    const signalsAt = o.signalsAt || ((sym, i) => agentSignals(U, sym, i, o.params));
    let cash = capital, orders = null, traded = 0, invSum = 0, buys = 0, sells = 0, riskSells = 0, intradayExits = 0;
    const pos = {}, trades = [], curve = [], bench = [], days = [], cool = {}, ix = o.intradayExit || {};
    for (let g = start; g <= end; g++) {
      if (orders) {
        for (const s of orders.sell) {
          const F = U.F[s], i = g - U.off[s], p = pos[s];
          if (!p || i < 0) continue;
          const px = F.o[i] * (1 - cost);
          cash += p.qty * px; traded += p.qty * px; sells++;
          trades.push({ sym: s, entry: p.entry, exit: px, qty: p.qty, pnl: (px - p.entry) * p.qty, pnlPct: px / p.entry - 1, entryG: p.entryG, exitG: g, reason: orders.why[s] });
          delete pos[s];
        }
        let eqOpen = cash;
        for (const s of Object.keys(pos)) eqOpen += pos[s].qty * U.F[s].o[g - U.off[s]];
        const per = eqOpen * frac * orders.scale / maxPos;
        for (const s of orders.buy) {
          if (Object.keys(pos).length >= maxPos) break;
          const F = U.F[s], i = g - U.off[s];
          if (pos[s] || i < 0) continue;
          const val = Math.min(cash, per);
          if (val < per * 0.5) break;
          const px = F.o[i] * (1 + cost);
          if (cool[s] != null && g - cool[s] < (ix.coolDays ?? 5)) continue;
          pos[s] = { qty: val / px, entry: px, entryG: g }; cash -= val; traded += val; buys++;
        }
        orders = null;
      }
      // intraday exits (the hourly guardian), judged on the day's range: a crash of `sigma` daily
      // standard deviations below yesterday's close, or a fall of stopPct from the entry price
      if (ix.sigma || ix.stopPct) for (const s of Object.keys(pos)) {
        const F = U.F[s], i = g - U.off[s], p = pos[s];
        if (i < 61) continue;
        let trig = -Infinity, why = '';
        if (ix.sigma) { let m = 0, v = 0; for (let k = i - 60; k < i; k++) m += F.c[k] / F.c[k - 1] - 1; m /= 60; for (let k = i - 60; k < i; k++) v += (F.c[k] / F.c[k - 1] - 1 - m) ** 2; const t = F.c[i - 1] * (1 - ix.sigma * Math.sqrt(v / 59)); if (t > trig) { trig = t; why = 'intraday crash'; } }
        if (ix.stopPct) { const t = p.entry * (1 - ix.stopPct); if (t > trig) { trig = t; why = 'stop'; } }
        if (F.l[i] > trig) continue;
        const px = Math.min(F.o[i], trig) * (1 - cost);
        cash += p.qty * px; traded += p.qty * px; sells++; intradayExits++;
        trades.push({ sym: s, entry: p.entry, exit: px, qty: p.qty, pnl: (px - p.entry) * p.qty, pnlPct: px / p.entry - 1, entryG: p.entryG, exitG: g, reason: why });
        delete pos[s]; cool[s] = g;
      }
      let eq = cash;
      for (const s of Object.keys(pos)) eq += pos[s].qty * U.F[s].c[g - U.off[s]];
      let bsum = 0, bn = 0;
      for (const s of U.syms) { const i = g - U.off[s], i0 = start - U.off[s]; if (i0 >= 0) { bsum += U.F[s].c[i] / U.F[s].c[i0]; bn++; } }
      curve.push(eq); bench.push(bn ? capital * bsum / bn : capital); days.push(g);
      invSum += (eq - cash) / eq;
      if (g === end) break;
      const sell = [], why = {}, cands = [];
      let mkt = 0;
      for (const s of U.syms) {
        const i = g - U.off[s];
        if (i < 130) continue;
        const sg = signalsAt(s, i);
        if (!sg) continue;
        const d = teamDecision(sg, { held: !!pos[s], weights: o.weightsAt ? o.weightsAt(g) : o.weights, ...(o.decision || {}) });
        mkt = d.mkt;
        if (d.action === 'SELL') { sell.push(s); why[s] = d.why; if (/risk/.test(d.why)) riskSells++; }
        else if (d.action === 'BUY') cands.push([s, d.score]);
      }
      cands.sort((a, b) => b[1] - a[1]);
      if (sell.length || cands.length) orders = { sell, why, buy: cands.map(x => x[0]), scale: mkt < -(o.timingThr ?? 0.2) ? 0.5 : 1 };
    }
    for (const s of Object.keys(pos)) {
      const F = U.F[s], i = end - U.off[s], p = pos[s];
      trades.push({ sym: s, entry: p.entry, exit: F.c[i], qty: p.qty, pnl: (F.c[i] - p.entry) * p.qty, pnlPct: F.c[i] / p.entry - 1, entryG: p.entryG, exitG: end, reason: 'END' });
    }
    const rets = curve.slice(1).map((v, k) => v / curve[k] - 1);
    const mu = rets.reduce((s, r) => s + r, 0) / (rets.length || 1);
    const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mu) ** 2, 0) / (rets.length || 1));
    const brets = bench.slice(1).map((v, k) => v / bench[k] - 1);
    const bmu = brets.reduce((s, r) => s + r, 0) / (brets.length || 1);
    const bsd = Math.sqrt(brets.reduce((s, r) => s + (r - bmu) ** 2, 0) / (brets.length || 1));
    const dd = (c) => { let peak = -Infinity, m = 0; for (const v of c) { peak = Math.max(peak, v); m = Math.min(m, (v - peak) / peak); } return m; };
    const years = Math.max(1 / 252, curve.length / 252), avgEq = curve.reduce((s, v) => s + v, 0) / (curve.length || 1);
    const closed = trades.filter(t => t.reason !== 'END');
    return {
      curve, bench, days, trades,
      totalReturn: curve[curve.length - 1] / capital - 1, benchReturn: bench[bench.length - 1] / capital - 1,
      sharpe: sd > 0 ? (mu / sd) * Math.sqrt(252) : 0, benchSharpe: bsd > 0 ? (bmu / bsd) * Math.sqrt(252) : 0,
      maxDD: dd(curve), benchMaxDD: dd(bench), invested: invSum / (curve.length || 1),
      buys, sells, riskSells, intradayExits, turnover: traded / avgEq / years,
      winRate: closed.length ? closed.filter(t => t.pnl > 0).length / closed.length : 0,
      avgHoldDays: closed.length ? closed.reduce((s, t) => s + (t.exitG - t.entryG), 0) / closed.length : 0,
    };
  }

  // ── Learning (step 3): score every call, daily scorecard, damped weight updates ────────────────────
  // Every agent's vote on every watched stock is a call, traded or not. A call made at day g's close is
  // scored when its horizon H has passed: the stock's return from the next open to the close H days
  // later, relative to the watchlist average (so a rising market doesn't flatter every BUY). Each day,
  // each picker gets one score per horizon: the rank correlation (IC) between its votes and those
  // relative returns across the watchlist. The market agent is scored on the whole market's direction,
  // the risk guardian on whether danger came before turbulence, and the team on its BUY calls after a
  // round-trip cost. Votes are recomputed from the bars (they depend only on past prices), so the
  // record can be rebuilt from broker history and the first scorecard starts from a year of real calls.
  //
  // Weights: each picker's weight moves 10% of the way each day towards 1 + (|t| − 1)/2 in the direction
  // of t (clamped 0.25–2.5), where t is its record's t-statistic averaged over the 5- and 21-day horizons,
  // counting overlapping days only once per horizon. |t| ≤ 1 is treated as noise (weight stays 1): on
  // real 2013–2026 data, ungated weights chased noise and cut the team's return; gated, they did no harm. Weights are renormalised to average 1, so a picker that keeps helping
  // gains influence on the team's confidence, one that keeps hurting loses it, and noise moves little.
  // The 4-of-7 vote count is unchanged. A picker with t ≤ −2 over at least 60 scored days is flagged as
  // a retire candidate; retiring it is a decision for its owner.
  const LEARN = { horizons: [5, 21], keepDays: 250, minDays: 20, rate: 0.1, seedRate: 0.5, wMin: 0.25, wMax: 2.5, tScale: 0.5,
    retireT: -2, retireDays: 60, costBps: 5, keepHistory: 120, tDead: 1 };

  function spearman(a, b) {
    const n = a.length;
    if (n < 5) return null;
    const rank = (v) => { const o = v.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]); const r = new Array(n); let k = 0;
      while (k < n) { let j = k; while (j + 1 < n && o[j + 1][0] === o[k][0]) j++; for (let m = k; m <= j; m++) r[o[m][1]] = (k + j) / 2; k = j + 1; } return r; };
    const ra = rank(a), rb = rank(b), m = (n - 1) / 2;
    let num = 0, da = 0, db = 0;
    for (let k = 0; k < n; k++) { num += (ra[k] - m) * (rb[k] - m); da += (ra[k] - m) ** 2; db += (rb[k] - m) ** 2; }
    return da > 0 && db > 0 ? num / Math.sqrt(da * db) : null;
  }

  // Market date of each global bar index (from the longest-history symbol)
  function universeDates(U) {
    const s = U.syms.find(x => U.off[x] === 0);
    return s && U.F[s].t ? Array.from({ length: U.L }, (_, g) => String(U.F[s].t[g]).slice(0, 10)) : null;
  }

  // All of one day's calls scored at every horizon that has passed: { [H]: score }
  function scoreDay(U, g, horizons, { weights, params, costBps = LEARN.costBps } = {}) {
    const rows = [];
    for (const s of U.syms) {
      const F = U.F[s], i = g - U.off[s];
      if (i < 130) continue;
      const sg = agentSignals(U, s, i, params);
      if (!sg) continue;
      rows.push({ s, F, i, sg, team: teamDecision(sg, { weights }), danger: -(agentReadings(U, s, i, params).risk) });
    }
    const out = {};
    for (const H of horizons) {
      const ok = rows.filter(r => r.i + H <= r.F.n - 1);
      if (ok.length < 5) continue;
      const ret = ok.map(r => r.F.c[r.i + H] / r.F.o[r.i + 1] - 1);
      const mean = ret.reduce((a, b) => a + b, 0) / ret.length, rel = ret.map(x => x - mean);
      const ic = {};
      for (const id of PICKERS) { const v = ok.map(r => (r.sg[id] ? r.sg[id].dir * r.sg[id].strength : 0)); ic[id] = new Set(v).size > 1 ? spearman(v, rel) : null; }
      // turbulence: average absolute daily move over the horizon
      const turb = ok.map(r => { let t = 0; for (let k = 1; k <= H; k++) t += Math.abs(r.F.c[r.i + k] / r.F.c[r.i + k - 1] - 1); return t / H; });
      const dz = ok.map(r => r.danger), riskIC = dz.every(Number.isFinite) && new Set(dz).size > 1 ? spearman(dz, turb) : null;
      const cost = 2 * costBps / 1e4, buys = ok.map((r, k) => [r, rel[k]]).filter(([r]) => r.team.action === 'BUY');
      const m = ok[0].sg.mkt;
      out[H] = { n: ok.length, ic, riskIC, mkt: m ? Math.round(m.dir * m.strength * 100) / 100 : 0, mktRet: Math.round(mean * 1e5) / 1e5,
        buys: buys.length, buyRel: buys.length ? Math.round((buys.reduce((a, [, x]) => a + x, 0) / buys.length - cost) * 1e5) / 1e5 : null,
        buyHits: buys.filter(([, x]) => x > cost).length };
      for (const id of PICKERS) if (ic[id] != null) ic[id] = Math.round(ic[id] * 1e4) / 1e4;
      if (riskIC != null) out[H].riskIC = Math.round(riskIC * 1e4) / 1e4;
    }
    return out;
  }

  // Mean and overlap-aware t-statistic of a list of daily scores at horizon H
  function recordStats(xs, H) {
    const v = xs.filter(x => x != null && Number.isFinite(x)), n = v.length;
    if (n < 2) return { mean: n ? v[0] : 0, t: 0, n };
    const mean = v.reduce((a, b) => a + b, 0) / n, sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
    const nEff = Math.max(1, n / H);
    return { mean, t: sd > 0 ? (mean / sd) * Math.sqrt(nEff) : 0, n };
  }

  // Update the learning state with every call whose horizon has passed, then move the weights.
  // state: { days: { [H]: { 'YYYY-MM-DD': score } }, weights, lastUpdate, history: [{ date, weights }] }
  function learnUpdate(U, state = {}, o = {}) {
    const L = { ...LEARN, ...(o.learn || {}) }, dates = universeDates(U);
    if (!dates) return { state, scorecard: null, added: 0, error: 'bars have no dates' };
    const st = { days: {}, history: [], ...state };
    const prevW = st.weights ? { ...st.weights } : null;
    const weightsOn = (date) => { const h = (st.history || []).filter(x => x.date <= date).pop(); return h ? h.weights : prevW; };
    const todo = new Map(); // g -> horizons still to score
    for (const H of L.horizons) {
      const book = st.days[H] = { ...(st.days[H] || {}) };
      for (let g = Math.max(130, U.L - L.keepDays - H); g <= U.L - 1 - H; g++) if (!(dates[g] in book)) (todo.get(g) || todo.set(g, []).get(g)).push(H);
    }
    let added = 0;
    for (const [g, hs] of todo) {
      const sc = scoreDay(U, g, hs, { weights: weightsOn(dates[g]), params: o.params, costBps: L.costBps });
      for (const H of hs) if (sc[H]) { st.days[H][dates[g]] = sc[H]; added++; }
    }
    // keep the last keepDays scored days per horizon
    for (const H of L.horizons) { const keys = Object.keys(st.days[H]).sort(); for (const k of keys.slice(0, Math.max(0, keys.length - L.keepDays))) delete st.days[H][k]; }

    const asOf = dates[U.L - 1];
    const stats = {};
    for (const id of PICKERS) {
      stats[id] = {};
      for (const H of L.horizons) stats[id][H] = recordStats(Object.keys(st.days[H]).sort().map(k => st.days[H][k].ic[id]), H);
    }
    const days = Math.min(...L.horizons.map(H => Object.keys(st.days[H]).length));
    const target = {}, w = {};
    for (const id of PICKERS) {
      const t = L.horizons.reduce((a, H) => a + stats[id][H].t, 0) / L.horizons.length;
      const tt = Math.sign(t) * Math.max(0, Math.abs(t) - L.tDead); // evidence gate: |t| ≤ tDead is treated as noise
      target[id] = Math.min(L.wMax, Math.max(L.wMin, 1 + L.tScale * tt));
    }
    const fresh = st.lastUpdate !== asOf && added > 0;
    for (const id of PICKERS) {
      const cur = prevW && prevW[id] != null ? prevW[id] : 1;
      w[id] = days < L.minDays ? cur : !prevW ? 1 + L.seedRate * (target[id] - 1) : fresh ? cur + L.rate * (target[id] - cur) : cur;
    }
    const avg = PICKERS.reduce((a, id) => a + w[id], 0) / PICKERS.length;
    for (const id of PICKERS) w[id] = Math.round((w[id] / avg) * 1000) / 1000;
    st.weights = w;
    if (fresh || !prevW) { st.lastUpdate = asOf; st.history = [...(st.history || []).filter(x => x.date !== asOf), { date: asOf, weights: w }].slice(-L.keepHistory); }

    // the scorecard
    const main = Math.max(...L.horizons), keys = (H) => Object.keys(st.days[H]).sort();
    const agents = PICKERS.map(id => {
      const s = stats[id], t = L.horizons.reduce((a, H) => a + s[H].t, 0) / L.horizons.length, n = s[main].n;
      const status = n < L.minDays ? 'too early' : t <= L.retireT && n >= L.retireDays ? 'retire candidate' : t >= 2 ? 'helping' : t <= -1 ? 'hurting' : t >= 1 ? 'promising' : 'no clear effect';
      return { id, weight: w[id], prevWeight: prevW ? prevW[id] : null, target: Math.round(target[id] * 1000) / 1000, t: Math.round(t * 100) / 100, status,
        horizons: Object.fromEntries(L.horizons.map(H => [H, { ic: Math.round(s[H].mean * 1e4) / 1e4, t: Math.round(s[H].t * 100) / 100, days: s[H].n }])) };
    });
    const mk = keys(main).map(k => st.days[main][k]), called = mk.filter(d => Math.abs(d.mkt) >= 0.2);
    const timing = { days: mk.length, calls: called.length, hitRate: called.length ? Math.round(called.filter(d => Math.sign(d.mkt) === Math.sign(d.mktRet)).length / called.length * 1000) / 1000 : null };
    const rk = recordStats(keys(5).map(k => st.days[5] && st.days[5][k].riskIC), 5);
    const risk = { ic: Math.round(rk.mean * 1e4) / 1e4, t: Math.round(rk.t * 100) / 100, days: rk.n, status: rk.n < L.minDays ? 'too early' : rk.t >= 2 ? 'spots turbulence' : 'no clear effect' };
    const team = {};
    for (const H of L.horizons) {
      const ds = keys(H).map(k => st.days[H][k]).filter(d => d.buys > 0), calls = ds.reduce((a, d) => a + d.buys, 0);
      team[H] = { days: ds.length, calls, avgRelPct: calls ? Math.round(ds.reduce((a, d) => a + d.buyRel * d.buys, 0) / calls * 1e4) / 100 : null,
        hitRate: calls ? Math.round(ds.reduce((a, d) => a + d.buyHits, 0) / calls * 1000) / 1000 : null };
    }
    return { state: st, added, scorecard: { asOf, days, agents, timing, risk, team, horizons: L.horizons, updated: fresh || !prevW } };
  }

  function runTilt(U, o = {}) {
    const start = Math.max(o.start ?? 130, 130), end = Math.min(o.end ?? U.L - 1, U.L - 1);
    const capital = o.capital ?? 100000, cost = costOf(o), frac = o.investFraction ?? 1;
    const N = U.syms.length, K = effectiveTopK(o.topK, N);
    const scoreAt = o.scoreAt || ((sym, i) => trendScore(U.F[sym], i, (o.params && o.params.trend) || TREND_PARAMS));
    let cash = capital;
    const pos = {}; // sym → { qty, entry, entryG }
    const trades = [], curve = [], bench = [], days = [], picks = [];
    let orders = null, traded = 0, invSum = 0, rebalances = 0, riskOffDays = 0;
    for (let g = start; g <= end; g++) {
      if (orders) {
        let eqOpen = cash;
        for (const s of Object.keys(pos)) { const F = U.F[s]; eqOpen += pos[s].qty * F.o[g - U.off[s]]; }
        for (const s of orders.sell) {
          const F = U.F[s], i = g - U.off[s], p = pos[s];
          if (!p || i < 0) continue;
          const px = F.o[i] * (1 - cost);
          cash += p.qty * px; traded += p.qty * px;
          trades.push({ sym: s, entry: p.entry, exit: px, qty: p.qty, pnl: (px - p.entry) * p.qty, pnlPct: px / p.entry - 1, entryG: p.entryG, exitG: g, reason: 'REBALANCE' });
          delete pos[s];
        }
        const per = eqOpen * frac / K;
        for (const s of orders.buy) {
          const F = U.F[s], i = g - U.off[s];
          if (pos[s] || i < 0) continue;
          const px = F.o[i] * (1 + cost), val = Math.min(cash, per);
          if (val <= 1) continue;
          pos[s] = { qty: val / px, entry: px, entryG: g }; cash -= val; traded += val;
        }
        orders = null;
      }
      let eq = cash;
      for (const s of Object.keys(pos)) { const F = U.F[s]; eq += pos[s].qty * F.c[g - U.off[s]]; }
      let bsum = 0, bn = 0;
      for (const s of U.syms) { const i = g - U.off[s], i0 = start - U.off[s]; if (i0 >= 0) { bsum += U.F[s].c[i] / U.F[s].c[i0]; bn++; } }
      curve.push(eq); bench.push(bn ? capital * bsum / bn : capital); days.push(g);
      invSum += (eq - cash) / eq;
      if (g === end) break;
      const me = monthEnd(U, g);
      const monthly = g === start || (me == null ? (g - start) % 21 === 0 : me);
      // Optional crash guard: o.riskOff(g) true → sell everything and wait in cash. Checked at month ends,
      // or every day with o.riskOffDaily. Back in at the next check where it's false.
      if (o.riskOff && (monthly || o.riskOffDaily)) {
        const off = o.riskOff(g);
        if (off) { if (Object.keys(pos).length) { orders = { sell: Object.keys(pos), buy: [] }; rebalances++; } riskOffDays++; continue; }
        if (!monthly && Object.keys(pos).length === 0) { /* guard just lifted mid-month: re-enter now */ }
        else if (!monthly) continue;
      } else if (!monthly) continue;
      const ranked = U.syms
        .map(s => [s, scoreAt(s, g - U.off[s])])
        .filter(x => Number.isFinite(x[1]))
        .sort((a, b) => b[1] - a[1]);
      if (ranked.length < K) continue;
      const keep = new Set(ranked.slice(0, K).map(x => x[0]));
      orders = { sell: Object.keys(pos).filter(s => !keep.has(s)), buy: [...keep].filter(s => !pos[s]) };
      picks.push({ g, keep: [...keep] });
      rebalances++;
    }
    for (const s of Object.keys(pos)) {
      const F = U.F[s], i = end - U.off[s], p = pos[s];
      trades.push({ sym: s, entry: p.entry, exit: F.c[i], qty: p.qty, pnl: (F.c[i] - p.entry) * p.qty, pnlPct: F.c[i] / p.entry - 1, entryG: p.entryG, exitG: end, reason: 'END' });
    }
    const rets = curve.slice(1).map((v, k) => v / curve[k] - 1);
    const mu = rets.reduce((s, r) => s + r, 0) / (rets.length || 1);
    const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mu) ** 2, 0) / (rets.length || 1));
    let peak = -Infinity, maxDD = 0;
    for (const v of curve) { peak = Math.max(peak, v); maxDD = Math.min(maxDD, (v - peak) / peak); }
    const avgEq = curve.reduce((s, v) => s + v, 0) / (curve.length || 1);
    const years = Math.max(1 / 252, curve.length / 252);
    return {
      curve, bench, days, trades, picks,
      finalEq: curve[curve.length - 1] ?? capital,
      totalReturn: (curve[curve.length - 1] ?? capital) / capital - 1,
      benchReturn: (bench[bench.length - 1] ?? capital) / capital - 1,
      tradeCount: trades.length, rebalances,
      winRate: trades.length ? trades.filter(t => t.pnl > 0).length / trades.length : 0,
      avgTradePct: trades.length ? trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length : 0,
      sharpe: sd > 0 ? (mu / sd) * Math.sqrt(252) : 0, maxDD,
      invested: curve.length ? invSum / curve.length : 0,
      turnover: traded / avgEq / years, // traded value per year, in multiples of equity
      riskOffDays,
    };
  }

  // ── Combination model ──────────────────────────────────────────────────────
  // Agents as scores: each agent's call on a stock becomes a number in [−1, 1] (direction × strength).
  // A ridge regression turns the raw trend score plus those agent scores into an expected next-H-day
  // return relative to the other stocks that day. It is shrunk toward a prior that only trusts the trend
  // score, so with little or noisy data it ranks like the plain trend score and moves away only as
  // evidence accumulates.
  const MODEL = { H: 21, window: 500, step: 5, lambda: 1.0, priorIC: 0.05 };

  function solve(A, b) { // Gaussian elimination with partial pivoting (small dense systems)
    const n = b.length, M = A.map((r, k) => [...r, b[k]]);
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      [M[c], M[p]] = [M[p], M[c]];
      if (Math.abs(M[c][c]) < 1e-12) continue;
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = M[r][c] / M[c][c];
        for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
      }
    }
    return M.map((r, k) => (Math.abs(r[k]) < 1e-12 ? 0 : r[n] / r[k]));
  }

  const scoreVec = (sig, ids) => ids.map(id => (sig && sig[id] ? sig[id].dir * sig[id].strength : 0));
  // Model features: the raw trend score (6 months to 1 month ago) first, then the chosen agents' scores
  const featureVec = (U, sym, i, sig, ids) => { const t = trendScore(U.F[sym], i); return [fin(t) ? t : 0, ...scoreVec(sig, ids)]; };

  // Fit on calls made in (asOf − H − window, asOf − H]: only outcomes known by `asOf`.
  function fitModel(U, o) {
    const m = { ...MODEL, ...o };
    const ids = m.ids || AGENT_IDS;
    const signalsAt = m.signalsAt || ((s, i) => agentSignals(U, s, i, m.params));
    const X = [], y = [];
    const last = m.asOf - m.H, first = Math.max(130, last - m.window + 1);
    for (let d = last; d >= first; d -= m.step) {
      const rowsX = [], rowsY = [];
      for (const s of U.syms) {
        const F = U.F[s], i = d - U.off[s];
        if (i < 130 || i + m.H > F.n - 1) continue;
        const r = F.c[i + m.H] / F.o[i + 1] - 1;
        if (!fin(r)) continue;
        rowsX.push(featureVec(U, s, i, signalsAt(s, i), ids)); rowsY.push(r);
      }
      if (rowsX.length < 5) continue;
      // cross-sectional demeaning: the model predicts which stocks beat the others, not the market
      const my = rowsY.reduce((a, b) => a + b, 0) / rowsY.length;
      const mx = rowsX[0].map((_, k) => rowsX.reduce((a, r) => a + r[k], 0) / rowsX.length);
      rowsX.forEach((r, j) => { X.push(r.map((v, k) => v - mx[k])); y.push(rowsY[j] - my); });
    }
    const n = y.length, p = ids.length + 1;
    if (n < 50) return { ids, beta: null, n, status: 'warming-up' };
    const sd = Array.from({ length: p }, (_, k) => Math.sqrt(X.reduce((a, r) => a + r[k] ** 2, 0) / n) || 1);
    const sdy = Math.sqrt(y.reduce((a, v) => a + v * v, 0) / n) || 1;
    const Z = X.map(r => r.map((v, k) => v / sd[k]));
    // prior: trust the trend score at a modest information coefficient, nothing else
    const prior = Array.from({ length: p }, (_, k) => (k === 0 ? m.priorIC * sdy : 0));
    const lam = m.lambda * n;
    const A = prior.map((_, a) => prior.map((__, b) => Z.reduce((s, r) => s + r[a] * r[b], 0) + (a === b ? lam : 0)));
    const rhs = prior.map((_, a) => Z.reduce((s, r, j) => s + r[a] * y[j], 0) + lam * prior[a]);
    const beta = solve(A, rhs);
    return { ids, beta, sd, n, status: 'ok', fittedAt: m.asOf, H: m.H, features: ['trend', ...ids] };
  }

  // Model score for one stock (higher = expected to beat the other stocks)
  function modelScore(model, sig, U, sym, i) {
    if (!model || !model.beta) return NaN;
    const x = featureVec(U, sym, i, sig, model.ids);
    return x.reduce((s, v, k) => s + model.beta[k] * v / model.sd[k], 0);
  }

  // Rank correlation (Spearman) of a score with the next-H-day return across stocks, averaged over days.
  // With step = H the days don't overlap, so the t-statistic is honest.
  function rankIC(U, scoreFn, { from, to, H = 21, step = 21 } = {}) {
    const rank = (v) => { const o = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]); const r = new Array(v.length); o.forEach(([, i], k) => { r[i] = k; }); return r; };
    const ics = [];
    for (let d = Math.max(130, from); d <= to - H; d += step) {
      const a = [], b = [];
      for (const s of U.syms) {
        const F = U.F[s], i = d - U.off[s];
        if (i < 130 || i + H > F.n - 1) continue;
        const sc = scoreFn(s, i), r = F.c[i + H] / F.o[i + 1] - 1;
        if (!fin(sc) || !fin(r)) continue;
        a.push(sc); b.push(r);
      }
      if (a.length < 5 || new Set(a).size < 2) continue;
      const ra = rank(a), rb = rank(b), n = a.length, ma = (n - 1) / 2;
      let num = 0, da = 0, db = 0;
      for (let k = 0; k < n; k++) { num += (ra[k] - ma) * (rb[k] - ma); da += (ra[k] - ma) ** 2; db += (rb[k] - ma) ** 2; }
      ics.push(num / Math.sqrt(da * db));
    }
    const n = ics.length, mean = n ? ics.reduce((a, b) => a + b, 0) / n : 0;
    const sd = n > 1 ? Math.sqrt(ics.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
    return { mean, t: sd > 0 ? mean / (sd / Math.sqrt(n)) : 0, n };
  }

  // Evidence per agent: rank IC of its score for next-month relative returns
  function agentEvidence(U, o = {}) {
    const signalsAt = o.signalsAt || ((s, i) => agentSignals(U, s, i, o.params));
    const from = o.from ?? 130, to = o.to ?? U.L - 1;
    const out = {};
    for (const id of o.ids || AGENT_IDS) {
      out[id] = rankIC(U, (s, i) => { const sg = signalsAt(s, i); return sg && sg[id] ? sg[id].dir * sg[id].strength : 0; }, { from, to, H: o.H ?? 21 });
    }
    return out;
  }

  // Walk-forward model ranking for Rank & tilt. Every `refit` bars:
  //  1. measure each agent's evidence on the history so far and keep agents with positive evidence (t ≥ tMin)
  //  2. watch-it-first gate (gate: true): a candidate fitted only on data known `testDays` ago must rank
  //     stocks better (rank IC) than the current scorer over those `testDays`, which it never saw;
  //     if so it is adopted, refitted on all data known now
  // Until a model is adopted it ranks by the plain trend score.
  function createModelScorer(U, signalsAt, o = {}) {
    const refit = o.refit ?? 63, tMin = o.tMin ?? 1, testDays = o.testDays ?? 60, gate = o.gate !== false, H = MODEL.H;
    const state = { model: null, lastFit: -Infinity, kept: [], fits: [] };
    const scoreWith = (model) => (sym, i) => {
      const sc = model && model.beta ? modelScore(model, signalsAt(sym, i), U, sym, i) : NaN;
      return fin(sc) ? sc : trendScore(U.F[sym], i);
    };
    const keptAt = (g) => {
      const ev = agentEvidence(U, { signalsAt, from: 130, to: g });
      return { ev, kept: AGENT_IDS.filter(id => ev[id].mean > 0 && ev[id].t >= tMin) };
    };
    const scoreAt = (sym, i) => {
      const g = i + U.off[sym];
      if (g - state.lastFit >= refit || g < state.lastFit) {
        state.lastFit = g;
        let adopt = true, icNew = null, icCur = null;
        if (gate) {
          const past = keptAt(g - testDays);
          const cand = fitModel(U, { asOf: g - testDays, ids: past.kept, signalsAt });
          if (!cand.beta) adopt = false;
          else {
            const win = { from: g - testDays - H + 1, to: g, H, step: 5 };
            icNew = rankIC(U, scoreWith(cand), win).mean;
            icCur = rankIC(U, scoreWith(state.model), win).mean;
            adopt = icNew > icCur;
          }
        }
        if (adopt) {
          const now = keptAt(g);
          const m = fitModel(U, { asOf: g, ids: now.kept, signalsAt });
          if (m.beta) { state.model = m; state.kept = now.kept; state.evidence = now.ev; }
        }
        state.fits.push({ g, adopted: adopt, kept: state.kept, beta: state.model?.beta || null, icNew, icCur });
      }
      return scoreWith(state.model)(sym, i);
    };
    return { scoreAt, state };
  }

  // ── Walk-forward portfolio backtest ────────────────────────────────────────
  // Signals at day g's close, entries at day g+1's open, ATR stops/targets checked against each day's
  // high/low (stop assumed first if both are hit), time stop after maxHold days.
  function runBacktest(U, o = {}) {
    const ids = o.ids || AGENT_IDS;
    const signalsAt = o.signalsAt || ((sym, i) => agentSignals(U, sym, i, o.params));
    const start = Math.max(o.start ?? 0, 60), end = Math.min(o.end ?? U.L - 1, U.L - 1);
    const capital = o.capital ?? 100000, slip = costOf(o);
    const minConf = o.minConf ?? 0.3, minCons = o.minConsensus ?? 2, maxPos = o.maxPos ?? 8;
    const atrStop = o.atrStop ?? 2, atrTarget = o.atrTarget ?? 3, maxHold = o.maxHold ?? 10;
    const weights = { ...(o.weights || {}) };
    ids.forEach(id => { if (weights[id] == null) weights[id] = 1 / ids.length; });
    const regimeHist = {}; // regime → id → [bool]
    const voteRows = [];
    let cash = capital;
    const open = []; // { sym, side, qty, entry, stop, target, entryG, votes, regime }
    const pending = [];
    const trades = [];
    const curve = [], bench = [], days = [];

    const closePos = (p, px, g, reason) => {
      const pnl = (p.side === 1 ? px - p.entry : p.entry - px) * p.qty;
      cash += p.qty * p.entry + pnl;
      const tr = { sym: p.sym, side: p.side, entry: p.entry, exit: px, qty: p.qty, pnl, pnlPct: pnl / (p.qty * p.entry), entryG: p.entryG, exitG: g, reason, regime: p.regime, votes: p.votes };
      trades.push(tr);
      const out = pnl > 0 ? 1 : -1;
      const rh = (regimeHist[p.regime] = regimeHist[p.regime] || {});
      for (const id of ids) {
        const v = p.votes[id];
        if (!v) continue;
        (rh[id] = rh[id] || []).push(v * p.side * out > 0);
        if (rh[id].length > 60) rh[id].shift();
      }
    };

    for (let g = start; g <= end; g++) {
      // 1. fill yesterday's orders at today's open
      for (const ord of pending.splice(0)) {
        const f = U.F[ord.sym], i = g - U.off[ord.sym];
        if (i < 0 || open.length >= maxPos || open.some(p => p.sym === ord.sym)) continue;
        const px = f.o[i] * (1 + slip * ord.side);
        const qty = ord.notional / px;
        if (qty <= 0 || ord.notional > cash) continue;
        cash -= ord.notional;
        open.push({ ...ord, entry: px, qty, stop: px * (1 - ord.side * ord.stopPct), target: px * (1 + ord.side * ord.tpPct), entryG: g });
      }
      // 2. exits during today
      for (let k = open.length - 1; k >= 0; k--) {
        const p = open[k], f = U.F[p.sym], i = g - U.off[p.sym];
        if (i < 0) continue;
        let px = null, why = null;
        const hitStop = p.side === 1 ? f.l[i] <= p.stop : f.h[i] >= p.stop;
        const hitTgt = p.side === 1 ? f.h[i] >= p.target : f.l[i] <= p.target;
        if (hitStop) { px = p.side === 1 ? Math.min(p.stop, f.o[i]) : Math.max(p.stop, f.o[i]); why = 'STOP'; }
        else if (hitTgt) { px = p.side === 1 ? Math.max(p.target, f.o[i]) : Math.min(p.target, f.o[i]); why = 'TARGET'; }
        else if (g - p.entryG >= maxHold) { px = f.c[i]; why = 'TIME'; }
        if (px != null) { closePos(p, px * (1 - slip * p.side), g, why); open.splice(k, 1); }
      }
      // 3. mark to market
      let eq = cash;
      for (const p of open) {
        const f = U.F[p.sym], i = g - U.off[p.sym];
        const c = i >= 0 ? f.c[i] : p.entry;
        eq += p.qty * p.entry + (p.side === 1 ? c - p.entry : p.entry - c) * p.qty;
      }
      // benchmark: equal-weight buy-and-hold of the universe from `start`
      let bsum = 0, bn = 0;
      for (const s of U.syms) {
        const i = g - U.off[s], i0 = start - U.off[s];
        if (i0 >= 0 && U.F[s].c[i0] > 0) { bsum += U.F[s].c[i] / U.F[s].c[i0]; bn++; }
      }
      curve.push(eq); bench.push(bn ? capital * bsum / bn : capital); days.push(g);
      if (g === end) break;
      // 4. today's close → orders for tomorrow
      const corrAdj = o.corrAware === false ? null : correlationAdjust(voteRows, ids);
      const cands = [];
      for (const sym of U.syms) {
        if (open.some(p => p.sym === sym)) continue;
        const f = U.F[sym], i = g - U.off[sym];
        if (i < 60) continue;
        const sigs = signalsAt(sym, i);
        if (!sigs) continue;
        voteRows.push(Object.fromEntries(ids.map(id => [id, sigs[id] ? sigs[id].dir : 0])));
        if (voteRows.length > 600) voteRows.shift();
        const reg = regimeAt(f, i).key;
        const rm = o.regimeAware === false ? null : regimeMultipliers(regimeHist[reg], ids);
        const ens = ensemble(sigs, o.weightsAt ? o.weightsAt(g) : weights, { ids, enabled: o.enabled, regimeMult: rm, corrAdj });
        if (!ens.dir || ens.confidence < minConf || ens.consensus < minCons) continue;
        const side = ens.dir === 'BUY' ? 1 : -1;
        if (side === -1 && o.allowShort === false) continue;
        cands.push({ sym, side, ens, reg, f, i });
      }
      cands.sort((a, b) => b.ens.confidence - a.ens.confidence);
      for (const cd of cands.slice(0, Math.max(0, maxPos - open.length))) {
        const atr = cd.f.atr(14)[cd.i];
        const plan = atrPlan({ price: cd.f.c[cd.i], atr, equity: eq, riskPct: o.riskPct ?? 1, maxTradePct: o.maxTradePct ?? 15, atrStop, atrTarget, confidence: cd.ens.confidence });
        if (!plan) continue;
        pending.push({ sym: cd.sym, side: cd.side, notional: plan.notional, stopPct: plan.stopPct, tpPct: plan.tpPct, votes: cd.ens.votes, regime: cd.reg, conf: cd.ens.confidence });
      }
    }
    // close anything still open at the last close
    for (const p of open.splice(0)) {
      const f = U.F[p.sym], i = end - U.off[p.sym];
      closePos(p, f.c[i], end, 'END');
    }
    const rets = curve.slice(1).map((v, k) => v / curve[k] - 1);
    const mu = rets.reduce((s, r) => s + r, 0) / (rets.length || 1);
    const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mu) ** 2, 0) / (rets.length || 1));
    let peak = -Infinity, maxDD = 0;
    for (const v of curve) { peak = Math.max(peak, v); maxDD = Math.min(maxDD, (v - peak) / peak); }
    const wins = trades.filter(t => t.pnl > 0).length;
    const byRegime = {};
    for (const t of trades) {
      const r = (byRegime[t.regime] = byRegime[t.regime] || { n: 0, wins: 0, pnl: 0 });
      r.n++; if (t.pnl > 0) r.wins++; r.pnl += t.pnl;
    }
    return {
      curve, bench, days, trades,
      finalEq: curve[curve.length - 1] ?? capital,
      totalReturn: (curve[curve.length - 1] ?? capital) / capital - 1,
      benchReturn: (bench[bench.length - 1] ?? capital) / capital - 1,
      tradeCount: trades.length,
      winRate: trades.length ? wins / trades.length : 0,
      avgTradePct: trades.length ? trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length : 0,
      sharpe: sd > 0 ? (mu / sd) * Math.sqrt(252) : 0,
      maxDD, byRegime,
    };
  }

  // ── Per-agent evaluation ───────────────────────────────────────────────────
  // For every symbol and bar from `start`, each firing agent is scored on the return from the next
  // open to the close `h` days later, in its direction. Also returns how alike agents vote.
  function evaluateAgents(U, o = {}) {
    const ids = o.ids || AGENT_IDS, h = o.h ?? 5, step = o.step ?? 1;
    const signalsAt = o.signalsAt || ((sym, i) => agentSignals(U, sym, i, o.params));
    const stats = {};
    ids.forEach(id => { stats[id] = { fires: 0, hits: 0, sum: 0, sum2: 0, samples: 0 }; });
    const voteRows = [];
    for (const sym of U.syms) {
      const F = U.F[sym];
      const from = Math.max(o.start ?? 60, 60);
      const to = Math.min(o.end ?? F.n - 1, F.n - 1 - h - 1);
      for (let i = from; i <= to; i += step) {
        const sigs = signalsAt(sym, i);
        if (!sigs) continue;
        const fwd = F.c[i + h] / F.o[i + 1] - 1;
        if (!fin(fwd)) continue;
        const row = {};
        for (const id of ids) {
          const s = sigs[id], st = stats[id];
          st.samples++;
          row[id] = s ? s.dir : 0;
          if (!s || !s.dir) continue;
          const r = s.dir * fwd;
          st.fires++; st.sum += r; st.sum2 += r * r; if (r > 0) st.hits++;
        }
        voteRows.push(row);
      }
    }
    const out = {};
    for (const id of ids) {
      const s = stats[id], n = s.fires;
      const mean = n ? s.sum / n : 0;
      const sd = n > 1 ? Math.sqrt(Math.max(0, s.sum2 / n - mean * mean)) : 0;
      out[id] = { fires: n, fireRate: s.samples ? n / s.samples : 0, hitRate: n ? s.hits / n : 0, meanRet: mean, tStat: sd > 0 ? mean / (sd / Math.sqrt(n)) : 0 };
    }
    // pairwise vote correlation
    const X = ids.map(id => voteRows.map(r => r[id]));
    const mu = X.map(x => x.reduce((a, b) => a + b, 0) / (x.length || 1));
    const sd = X.map((x, k) => Math.sqrt(x.reduce((a, b) => a + (b - mu[k]) ** 2, 0) / (x.length || 1)));
    const corr = ids.map((_, a) => ids.map((__, b) => {
      if (!(sd[a] > 0 && sd[b] > 0)) return 0;
      let c = 0;
      for (let t = 0; t < voteRows.length; t++) c += (X[a][t] - mu[a]) * (X[b][t] - mu[b]);
      return c / voteRows.length / (sd[a] * sd[b]);
    }));
    let s = 0, n = 0;
    for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) { if (sd[a] > 0 && sd[b] > 0) { s += Math.abs(corr[a][b]); n++; } }
    return { agents: out, corr, avgAbsCorr: n ? s / n : 0, samples: voteRows.length };
  }

  // ── Autopilot: shadow scoring, automatic weights, tested tuning ────────────
  // Every agent's call on every ticker is scored once its outcome is known: the return from the next
  // open to the close `h` days later, in the call's direction. One observation per agent per day (the
  // average over the tickers it called), so the t-statistic is over days, not correlated tickers.
  // Days are global universe indices; a call made on day g matures on day g + h.
  const TUNE_KEYS = {
    mom:      { id: 'lookback', values: [168, 210, 252] },
    hi52:     { id: 'window',   values: [126, 189, 252] },
    sect:     { id: 'lookback', values: [63, 126, 189] },
    rev:      { id: 'window',   values: [5, 10, 21] },
    lowvol:   { id: 'window',   values: [60, 120, 250] },
    volshock: { id: 'short',    values: [3, 5, 10] },
    drift:    { id: 'window',   values: [10, 20, 40] },
    mkt:      { id: 'sma',      values: [100, 150, 200] },
    risk:     { id: 'volRatio', values: [1.4, 1.6, 2.0] },
  };

  const AUTOPILOT = { h: 5, window: 120, minDays: 20, smooth: 5, tFloor: 0.5, testDays: 60 };

  // fwd return for a call on local bar i (next open → close h days later); null if not matured by local bar `upto`
  const fwdRet = (F, i, h, upto) => (i + h <= upto && i + 1 < F.n ? F.c[i + h] / F.o[i + 1] - 1 : null);

  // opts.side 'sell' scores only SELL calls — for the stay-invested style, where selling is the only
  // decision: a SELL call scores well when the stock then fell, badly when it rose.
  function createScoreBook(U, params, opts = {}) {
    const o = { ...AUTOPILOT, ...opts };
    const P = mergeParams(params);
    const sigCache = new Map();
    const dayCache = new Map(); // g → { id: mean signed return } for calls made on day g (all tickers)
    const signalsAt = (sym, i) => {
      const k = sym + ':' + i;
      if (!sigCache.has(k)) sigCache.set(k, agentSignals(U, sym, i, P));
      return sigCache.get(k);
    };
    // per-agent average signed outcome of the calls made on day g; requires g + h ≤ last bar
    const day = (g) => {
      if (dayCache.has(g)) return dayCache.get(g);
      const sum = {}, n = {};
      for (const sym of U.syms) {
        const F = U.F[sym], i = g - U.off[sym];
        if (i < 60) continue;
        const r = fwdRet(F, i, o.h, F.n - 1);
        if (r == null || !fin(r)) continue;
        const sg = signalsAt(sym, i);
        if (!sg) continue;
        for (const id of AGENT_IDS) {
          const s = sg[id];
          if (!s || !s.dir || (o.side === 'sell' && s.dir !== -1)) continue;
          sum[id] = (sum[id] || 0) + s.dir * r; n[id] = (n[id] || 0) + 1;
        }
      }
      const out = {};
      for (const id of Object.keys(sum)) out[id] = sum[id] / n[id];
      dayCache.set(g, out);
      return out;
    };
    // stats over calls made on days [from, to]
    const stats = (from, to) => {
      const acc = {};
      AGENT_IDS.forEach(id => { acc[id] = { days: 0, sum: 0, sum2: 0 }; });
      for (let g = Math.max(60, from); g <= to; g++) {
        const d = day(g);
        for (const id of Object.keys(d)) { const a = acc[id]; a.days++; a.sum += d[id]; a.sum2 += d[id] ** 2; }
      }
      const out = {};
      for (const id of AGENT_IDS) {
        const a = acc[id], m = a.days ? a.sum / a.days : 0;
        const sd = a.days > 1 ? Math.sqrt(Math.max(1e-12, a.sum2 / a.days - m * m)) : 0;
        out[id] = { days: a.days, mean: m, t: sd > 0 ? m / (sd / Math.sqrt(a.days)) : 0 };
      }
      return out;
    };
    // raw target weights using only outcomes matured by `asOf` (calls up to asOf − h)
    const target = (asOf) => {
      const st = stats(asOf - o.h - o.window + 1, asOf - o.h);
      const w = {};
      let tot = 0, evidence = false;
      for (const id of AGENT_IDS) {
        if (st[id].days >= o.minDays) evidence = true;
        w[id] = st[id].days >= o.minDays ? Math.max(0, st[id].t - o.tFloor) : 0;
        tot += w[id];
      }
      if (!evidence) { AGENT_IDS.forEach(id => { w[id] = 1 / AGENT_IDS.length; }); return { w, status: 'warming-up', stats: st }; }
      if (tot <= 0) return { w, status: 'no-edge', stats: st };
      AGENT_IDS.forEach(id => { w[id] /= tot; });
      return { w, status: 'ok', stats: st };
    };
    // smoothed: average of the last `smooth` days' targets, so weights move gradually
    const weightsAt = (asOf) => {
      const w = {};
      AGENT_IDS.forEach(id => { w[id] = 0; });
      let last;
      for (let k = 0; k < o.smooth; k++) {
        last = k === 0 ? target(asOf) : last;
        const t = k === 0 ? last : target(asOf - k);
        AGENT_IDS.forEach(id => { w[id] += t.w[id] / o.smooth; });
      }
      return { w, status: last.status, stats: last.stats };
    };
    // Paper result of a weight set on calls made in [from, to]: average per-day return of the ensemble's
    // acted-on calls. style 'invested' scores only SELL calls (the stock is avoided), 'both' scores both.
    const paper = (weights, from, to, { minConf = 0.55, style = 'both' } = {}) => {
      let sum = 0, days = 0, calls = 0;
      for (let g = Math.max(60, from); g <= to; g++) {
        let s = 0, n = 0;
        for (const sym of U.syms) {
          const F = U.F[sym], i = g - U.off[sym];
          if (i < 60) continue;
          const r = fwdRet(F, i, o.h, F.n - 1);
          if (r == null || !fin(r)) continue;
          const e = ensemble(signalsAt(sym, i), weights);
          if (!e.dir || e.confidence < minConf) continue;
          if (style === 'invested' && e.dir !== 'SELL') continue;
          s += (e.dir === 'BUY' ? 1 : -1) * r; n++;
        }
        if (n) { sum += s / n; days++; calls += n; }
      }
      return { mean: days ? sum / days : 0, days, calls };
    };
    return { U, params: P, opts: o, signalsAt, day, stats, target, weightsAt, paper };
  }

  // Watch-it-first: a challenger fitted only on outcomes known `testDays` ago must beat the current
  // weights on the calls made since (which it never saw) before it replaces them.
  function proposeWeights(book, asOf, current, opts = {}) {
    const { h, testDays } = book.opts;
    const fitAsOf = asOf - testDays;
    const challenger = book.weightsAt(fitAsOf);
    const from = fitAsOf - h + 1, to = asOf - h;
    const cur = current || Object.fromEntries(AGENT_IDS.map(id => [id, 1 / AGENT_IDS.length]));
    const a = book.paper(challenger.w, from, to, opts), b = book.paper(cur, from, to, opts);
    const noEdge = challenger.status === 'no-edge';
    return {
      challenger: challenger.w, status: challenger.status, stats: challenger.stats,
      challengerScore: a, currentScore: b,
      // with no edge anywhere, standing aside always beats trading noise
      promote: noEdge || (challenger.status === 'ok' && a.days >= 5 && a.mean > b.mean),
    };
  }

  // Tested tuning of one agent's main parameter: best value on older data [fit window], accepted only if it
  // also beats the current value on the newer `testDays` it wasn't chosen on, with enough signals in both.
  function tuneParam(U, agentId, asOf, params = {}, opts = {}) {
    const o = { ...AUTOPILOT, ...opts };
    const key = TUNE_KEYS[agentId];
    if (!key) return null;
    const cur = mergeParams(params)[agentId][key.id];
    const fitTo = asOf - o.testDays - o.h, fitFrom = fitTo - o.window + 1;
    const testFrom = fitTo + 1, testTo = asOf - o.h;
    const score = (val, from, to) => {
      const P = mergeParams({ ...params, [agentId]: { ...(params[agentId] || {}), [key.id]: val } })[agentId];
      let sum = 0, n = 0;
      for (const sym of U.syms) {
        const F = U.F[sym];
        for (let g = Math.max(60 + U.off[sym], from); g <= to; g++) {
          const i = g - U.off[sym];
          const r = fwdRet(F, i, o.h, F.n - 1);
          if (r == null || !fin(r)) continue;
          let s;
          try { s = AGENT_FNS[agentId](F, i, P, U, sym); } catch { s = null; }
          if (!s || !s.dir) continue;
          sum += s.dir * r; n++;
        }
      }
      return { mean: n ? sum / n : 0, n };
    };
    const values = [...new Set([cur, ...key.values])];
    const fit = values.map(v => ({ v, ...score(v, fitFrom, fitTo) })).filter(x => x.n >= 30);
    if (!fit.length) return { agentId, key: key.id, current: cur, best: cur, accepted: false, reason: 'too few signals' };
    fit.sort((a, b) => b.mean - a.mean);
    const best = fit[0];
    if (best.v === cur) return { agentId, key: key.id, current: cur, best: cur, accepted: false, reason: 'current value is best' };
    const tb = score(best.v, testFrom, testTo), tc = score(cur, testFrom, testTo);
    const accepted = tb.n >= 10 && tb.mean > tc.mean;
    return {
      agentId, key: key.id, current: cur, best: best.v, accepted,
      fitMean: best.mean, testMean: tb.mean, testMeanCurrent: tc.mean, testN: tb.n,
      reason: accepted ? 'better on older and newer data' : 'not better on newer data',
    };
  }

  // ── Stay-invested backtest ─────────────────────────────────────────────────
  // Hold every stock at an equal share of `investFraction` of equity; sell a stock when the ensemble calls
  // SELL with confidence ≥ minConf, buy it back when the SELL call clears. Decisions at the close, fills at
  // the next open. A daily loss beyond `dailyLoss`% blocks buying the next day.
  function runInvested(U, o = {}) {
    const start = Math.max(o.start ?? 60, 60), end = Math.min(o.end ?? U.L - 1, U.L - 1);
    const capital = o.capital ?? 100000, slip = costOf(o), frac = o.investFraction ?? 0.9;
    const minConf = o.minConf ?? 0.55;
    const signalsAt = o.signalsAt || ((sym, i) => agentSignals(U, sym, i, o.params));
    const weightsAt = o.weightsAt || (() => o.weights || {});
    const N = U.syms.length;
    let cash = capital;
    const pos = {}; // sym → { qty, entry, entryG }
    const trades = [], curve = [], bench = [], days = [];
    let orders = []; // { sym, side: 'buy' | 'sell' }
    let blockBuys = false, invSum = 0, prevEq = capital;
    for (let g = start; g <= end; g++) {
      // fills at today's open
      let eqOpen = cash;
      for (const s of Object.keys(pos)) { const F = U.F[s], i = g - U.off[s]; eqOpen += pos[s].qty * F.o[i]; }
      for (const od of orders) {
        const F = U.F[od.sym], i = g - U.off[od.sym];
        if (i < 0) continue;
        if (od.side === 'sell' && pos[od.sym]) {
          const p = pos[od.sym], px = F.o[i] * (1 - slip);
          cash += p.qty * px;
          trades.push({ sym: od.sym, entry: p.entry, exit: px, qty: p.qty, pnl: (px - p.entry) * p.qty, pnlPct: px / p.entry - 1, entryG: p.entryG, exitG: g, reason: 'WEAKNESS' });
          delete pos[od.sym];
        } else if (od.side === 'buy' && !pos[od.sym] && !blockBuys) {
          const px = F.o[i] * (1 + slip), val = Math.min(cash, eqOpen * frac / N);
          if (val > 1) { pos[od.sym] = { qty: val / px, entry: px, entryG: g }; cash -= val; }
        }
      }
      orders = [];
      // mark at the close
      let eq = cash;
      for (const s of Object.keys(pos)) { const F = U.F[s], i = g - U.off[s]; eq += pos[s].qty * F.c[i]; }
      let bsum = 0, bn = 0;
      for (const s of U.syms) { const i = g - U.off[s], i0 = start - U.off[s]; if (i0 >= 0) { bsum += U.F[s].c[i] / U.F[s].c[i0]; bn++; } }
      curve.push(eq); bench.push(bn ? capital * bsum / bn : capital); days.push(g);
      invSum += (eq - cash) / eq;
      blockBuys = o.dailyLoss != null && eq / prevEq - 1 <= -o.dailyLoss / 100;
      prevEq = eq;
      if (g === end) break;
      // decisions at the close for tomorrow's open
      const w = weightsAt(g);
      for (const s of U.syms) {
        const i = g - U.off[s];
        if (i < 60) continue;
        const e = ensemble(signalsAt(s, i), w);
        const weak = e.dir === 'SELL' && e.confidence >= minConf;
        if (weak && pos[s]) orders.push({ sym: s, side: 'sell' });
        else if (!weak && !pos[s]) orders.push({ sym: s, side: 'buy' });
      }
    }
    for (const s of Object.keys(pos)) {
      const F = U.F[s], i = end - U.off[s], p = pos[s];
      trades.push({ sym: s, entry: p.entry, exit: F.c[i], qty: p.qty, pnl: (F.c[i] - p.entry) * p.qty, pnlPct: F.c[i] / p.entry - 1, entryG: p.entryG, exitG: end, reason: 'END' });
    }
    const rets = curve.slice(1).map((v, k) => v / curve[k] - 1);
    const mu = rets.reduce((s, r) => s + r, 0) / (rets.length || 1);
    const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mu) ** 2, 0) / (rets.length || 1));
    let peak = -Infinity, maxDD = 0;
    for (const v of curve) { peak = Math.max(peak, v); maxDD = Math.min(maxDD, (v - peak) / peak); }
    const sells = trades.filter(t => t.reason === 'WEAKNESS');
    return {
      curve, bench, days, trades,
      finalEq: curve[curve.length - 1] ?? capital,
      totalReturn: (curve[curve.length - 1] ?? capital) / capital - 1,
      benchReturn: (bench[bench.length - 1] ?? capital) / capital - 1,
      tradeCount: trades.length, sells: sells.length,
      winRate: trades.length ? trades.filter(t => t.pnl > 0).length / trades.length : 0,
      avgTradePct: trades.length ? trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length : 0,
      sharpe: sd > 0 ? (mu / sd) * Math.sqrt(252) : 0, maxDD,
      invested: curve.length ? invSum / curve.length : 0,
    };
  }

  // ── Settings optimiser ─────────────────────────────────────────────────────
  // Searches the settings that drive returns for the highest return over a past window, using the same
  // walk-forward engines as the Backtest screen. A config is:
  //   { style: 'invested' | 'both', agents: 'default' | 'swarm' | <agentId>, minConf, investFraction,
  //     atrStop, atrTarget, maxHold, param: { agent, key, value } | null }
  // Coordinate search: starting from the current settings, try every value of one setting at a time and
  // keep any improvement; two passes.
  const OPT_SPACE = {
    style: ['tilt', 'invested', 'both'],
    topK: [6, 8, 12, 16],
    score: ['trend', 'model'],
    agents: ['default', 'swarm', ...AGENT_IDS],
    minConf: [0.45, 0.55, 0.65, 0.75],
    investFraction: [0.6, 0.8, 1.0],
    atrStop: [1.5, 2, 3],
    atrTarget: [2, 3, 5],
    maxHold: [5, 10, 20],
  };
  const OPT_WARMUP = 130; // bars of history needed before a window starts

  function configWeights(cfg) {
    return Object.fromEntries(AGENT_IDS.map(id => [id,
      cfg.agents === 'swarm' ? 1 / AGENT_IDS.length
        : cfg.agents === 'default' ? (cfg.style === 'both' ? 1 / AGENT_IDS.length : (id === 'mom' ? 1 : 0))
        : (id === cfg.agents ? 1 : 0)]));
  }
  function configParams(cfg, base = {}) {
    if (!cfg.param) return base;
    const { agent, key, value } = cfg.param;
    return { ...base, [agent]: { ...(base[agent] || {}), [key]: value } };
  }

  function createEvaluator(U, baseParams = {}, costBps) {
    const books = new Map();
    const bookFor = (params) => {
      const k = JSON.stringify(params);
      if (!books.has(k)) books.set(k, createScoreBook(U, params));
      return books.get(k);
    };
    return (cfg, from, to) => {
      const book = bookFor(configParams(cfg, baseParams));
      const weights = configWeights(cfg);
      const costs = costBps != null ? { costBps } : {};
      if (cfg.style === 'tilt') {
        const scoreAt = cfg.score === 'model' ? createModelScorer(U, book.signalsAt).scoreAt : undefined;
        const r = runTilt(U, { start: from, end: to, topK: cfg.topK, investFraction: cfg.investFraction, scoreAt, params: configParams(cfg, baseParams), ...costs });
        return { ret: r.totalReturn, bench: r.benchReturn, sharpe: r.sharpe, maxDD: r.maxDD, trades: r.tradeCount, curve: r.curve, benchCurve: r.bench, turnover: r.turnover };
      }
      const r = cfg.style === 'both'
        ? runBacktest(U, { start: from, end: to, weights, signalsAt: book.signalsAt, minConf: cfg.minConf, minConsensus: 1,
            maxPos: 25, riskPct: 1, maxTradePct: 5, atrStop: cfg.atrStop, atrTarget: cfg.atrTarget, maxHold: cfg.maxHold,
            regimeAware: false, corrAware: false, ...costs })
        : runInvested(U, { start: from, end: to, weights, signalsAt: book.signalsAt, minConf: cfg.minConf, investFraction: cfg.investFraction, ...costs });
      return { ret: r.totalReturn, bench: r.benchReturn, sharpe: r.sharpe, maxDD: r.maxDD, trades: r.tradeCount, curve: r.curve, benchCurve: r.bench };
    };
  }

  const tick = () => new Promise(r => setTimeout(r, 0));

  async function optimiseSettings(U, o) {
    const days = Math.round(o.days), to = o.asOf, from = to - days + 1;
    if (from < OPT_WARMUP) return { error: `Need ${OPT_WARMUP + days} days of history for a ${days}-day window; this data has ${to + 1}.` };
    const evaluate = createEvaluator(U, o.params || {}, o.costBps);
    const startCfg = { style: 'tilt', agents: 'default', minConf: 0.55, investFraction: 0.9, atrStop: 2, atrTarget: 3, maxHold: 7, topK: Math.ceil(U.syms.length / 2), score: 'trend', param: null, ...o.start };
    // Objective: after-cost return, minus a penalty for any drawdown beyond the cap (o.ddCap, e.g. 0.15).
    // Maximising raw return over a short window mostly rewards luck and concentration.
    const objective = (r) => (o.objective === 'return' || o.ddCap == null ? r.ret : r.ret - 2 * Math.max(0, -r.maxDD - o.ddCap));
    let evals = 0;
    const score = async (cfg) => { evals++; if (evals % 2 === 0) await tick(); const r = evaluate(cfg, from, to); return { ...r, obj: objective(r) }; };
    const baseline = { cfg: startCfg, ...(await score(startCfg)) };
    let best = baseline;
    // Fewer settings = fewer chances to fit noise: each style searches only what it uses
    const dims = (cfg) => {
      if (cfg.style === 'tilt') return ['style', 'topK', 'score', 'investFraction'];
      const d = ['style', 'agents', 'minConf'];
      if (cfg.style === 'both') d.push('atrStop', 'atrTarget', 'maxHold'); else d.push('investFraction');
      if (TUNE_KEYS[cfg.agents]) d.push('param');
      return d;
    };
    const valuesFor = (dim, cfg) => {
      if (dim === 'param') {
        const key = TUNE_KEYS[cfg.agents];
        if (!key) return []; // the agent choice changed earlier in this pass
        return [null, ...key.values.map(v => ({ agent: cfg.agents, key: key.id, value: v }))];
      }
      if ((dim === 'investFraction' && cfg.style === 'both') || (['atrStop', 'atrTarget', 'maxHold'].includes(dim) && cfg.style !== 'both')) return [];
      if (['topK', 'score'].includes(dim) && cfg.style !== 'tilt') return [];
      if (['agents', 'minConf', 'param'].includes(dim) && cfg.style === 'tilt') return [];
      if (dim === 'topK') return [...new Set([cfg.topK, ...OPT_SPACE.topK])].filter(k => k >= 2 && k < U.syms.length);
      return [...new Set([cfg[dim], ...OPT_SPACE[dim]])];
    };
    const total = 2 * (3 + 4 + 2 + 3 + 18 + 4 + 6); // rough, for the progress bar
    for (let pass = 0; pass < 2; pass++) {
      let improved = false;
      for (const dim of dims(best.cfg)) {
        for (const v of valuesFor(dim, best.cfg)) {
          if (JSON.stringify(v) === JSON.stringify(best.cfg[dim])) continue;
          const cfg = { ...best.cfg, [dim]: v };
          if (dim === 'agents' && cfg.param && cfg.param.agent !== v) cfg.param = null; // a tuned setting belongs to its agent
          const r = await score(cfg);
          if (r.obj > best.obj + 1e-9) { best = { cfg, ...r }; improved = true; }
          if (o.onProgress) o.onProgress(Math.min(0.99, evals / total));
        }
      }
      if (!improved) break;
    }
    // Held-out check: the same two configs on the `days` before the window — data the search never saw
    let heldOut = null;
    if (from - days >= OPT_WARMUP) {
      const hb = evaluate(best.cfg, from - days, from - 1), hc = evaluate(startCfg, from - days, from - 1);
      heldOut = { from: from - days, to: from - 1, best: { ...hb, obj: objective(hb) }, baseline: { ...hc, obj: objective(hc) } };
    }
    if (o.onProgress) o.onProgress(1);
    const changed = JSON.stringify(best.cfg) !== JSON.stringify(startCfg);
    // Gate: settings may only be applied if they also beat the current ones on the held-out days
    const canApply = changed && heldOut != null && heldOut.best.obj > heldOut.baseline.obj;
    return { from, to, days, baseline, best, heldOut, evals, changed, canApply, objective: o.objective === 'return' || o.ddCap == null ? 'return' : 'balanced', ddCap: o.ddCap };
  }

  // Frozen vs previous settings (each with its own agent parameters) and buy-and-hold, on [from, to].
  function compareSettings(U, { frozen, before, from, to }) {
    if (to - from + 1 < 1) return null;
    const a = createEvaluator(U, frozen.params || {}, frozen.costBps)(frozen.cfg, from, to);
    const b = createEvaluator(U, before.params || {}, before.costBps)(before.cfg, from, to);
    return { from, to, days: to - from + 1, frozen: a, before: b, bench: a.bench };
  }

  // ── Synthetic market (tests and offline demos) ──────────────────────────────────────
  // Market + sector + stock factors with regime switching (trending / ranging, calm / volatile),
  // opening gaps, intraday ranges and volume that swells on big moves.
  function synthUniverseBars(symbols, sectorOf, seed, n, basePrices = {}) {
    let a = seed | 0;
    const rnd = () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = a; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
    const gauss = () => { let u = 0, v = 0; while (u === 0) u = rnd(); v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    const sectors = [...new Set(symbols.map(s => sectorOf[s] || 'Other'))];
    const mkt = new Array(n).fill(0), sec = {};
    let mState = 0;
    for (let t = 0; t < n; t++) {
      if (rnd() < 0.01) mState = (mState + 1 + Math.floor(rnd() * 2)) % 3; // 0 calm-up, 1 calm-flat, 2 volatile-down
      const mu = [0.0005, 0, -0.0008][mState], sd = [0.007, 0.006, 0.016][mState];
      mkt[t] = mu + sd * gauss();
    }
    for (const sc of sectors) { sec[sc] = new Array(n).fill(0); for (let t = 0; t < n; t++) sec[sc][t] = 0.005 * gauss(); }
    const out = {};
    symbols.forEach((s, k) => {
      const o = [], h = [], l = [], c = [], v = [];
      let px = basePrices[s] || 50 + rnd() * 400;
      const beta = 0.7 + rnd() * 0.8, baseVol = 1e6 * (1 + rnd() * 20);
      let regime = rnd() < 0.5 ? 'trend' : 'range', drift = (rnd() - 0.5) * 0.004, anchor = Math.log(px), volMult = 1;
      for (let t = 0; t < n; t++) {
        if (rnd() < 0.02) { regime = regime === 'trend' ? 'range' : 'trend'; drift = (rnd() - 0.5) * 0.004; anchor = Math.log(px); }
        if (rnd() < 0.03) volMult = rnd() < 0.3 ? 1.8 : 1;
        const idio = 0.012 * volMult * gauss();
        let r = beta * mkt[t] + sec[sectorOf[s] || 'Other'][t] + idio;
        if (regime === 'trend') r += drift;
        else r += -0.06 * (Math.log(px) - anchor); // mean-reverting range around the anchor
        const gap = rnd() < 0.03 ? (rnd() - 0.5) * 0.06 : 0.25 * r + 0.002 * gauss();
        const open = px * (1 + gap);
        const close = Math.max(1, px * (1 + r));
        const intr = Math.abs(0.008 * volMult * gauss()) + Math.abs(close - open) / px * 0.2;
        const hi = Math.max(open, close) * (1 + intr * rnd());
        const lo = Math.min(open, close) * (1 - intr * rnd());
        o.push(open); h.push(hi); l.push(lo); c.push(close);
        v.push(Math.round(baseVol * Math.exp(0.3 * gauss()) * (1 + 25 * Math.abs(r) + (gap ? 10 * Math.abs(gap) : 0))));
        px = close;
      }
      out[s] = { o, h, l, c, v };
    });
    return out;
  }

  const api = {
    ind, normalizeBars, makeFeatures, buildUniverse, pairFor,
    REGIME_KEYS, REGIME_LABELS, regimeAt,
    AGENT_IDS, DEFAULT_PARAMS, mergeParams, agentSignals, AGENT_FNS, agentReadings, AGENT_ROLE, roleOf, PICKERS, teamDecision, DECISION, TREND_PARAMS, runTeam, LEARN, spearman, scoreDay, recordStats, learnUpdate, universeDates,
    ensemble, correlationAdjust, regimeMultipliers, atrPlan,
    runBacktest, evaluateAgents, synthUniverseBars,
    TUNE_KEYS, AUTOPILOT, createScoreBook, proposeWeights, tuneParam, runInvested,
    OPT_SPACE, OPT_WARMUP, configWeights, configParams, createEvaluator, optimiseSettings, compareSettings,
    COST_PROFILES, trendScore, runTilt, marketBelowAverage, effectiveTopK, MODEL, fitModel, modelScore, rankIC, agentEvidence, createModelScorer,
  };
  root.ShoalSignals = api;
})(typeof window !== 'undefined' ? window : globalThis);

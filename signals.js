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
  const DEFAULT_PARAMS = {
    momo: { fast: 12, slow: 26, adxMin: 20 },
    mean: { period: 20, k: 2.0, rsiLo: 30, rsiHi: 70, adxMax: 25 },
    brkt: { kcMult: 1.5, recent: 5, volZ: 0.5 },
    vwap: { period: 20, devThr: 1.5 },
    vol:  { lookback: 10, expand: 1.25, contract: 0.85 },
    skew: { window: 20, thr: 0.5 },
    flow: { period: 20, cmfThr: 0.1 },
    mm:   { nr: 7, atrRank: 0.3 },
    corr: { period: 20, rsThr: 0.03 },
    pair: { zEntry: 2.0, lookback: 60 },
    macr: { hi: 0.6, lo: 0.4 },
    earn: { lookback: 126, skip: 21, thr: 0.5 },
    fund: { period: 60, thr: 1.0 },
    news: { gapThr: 0.75, volZ: 1.0 },
    soc:  { volThr: 2.0 },
    patt: { k: 10, horizon: 5 },
  };
  const AGENT_IDS = Object.keys(DEFAULT_PARAMS);

  const NEUTRAL = Object.freeze({ dir: 0, strength: 0, note: 'no signal' });
  const sig = (dir, strength, note) => (dir && strength > 0.02 ? { dir, strength: +strength.toFixed(3), note } : { dir: 0, strength: 0, note: note || 'no signal' });
  const sign = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);
  const pct = (x) => `${(x * 100).toFixed(1)}%`;

  const AGENT_FNS = {
    // Trend Follower: MACD histogram and EMA order agree, only when ADX says the market is trending.
    momo(F, i, p) {
      const m = F.macd(p.fast, p.slow, 9), a = F.adx(14).adx[i], atr = F.atr(14)[i];
      const h = m.hist[i], gap = m.emaFast[i] - m.emaSlow[i];
      if (![h, gap, a, atr].every(fin)) return NEUTRAL;
      if (a < p.adxMin) return sig(0, 0, `ADX ${a.toFixed(0)} < ${p.adxMin}: no trend`);
      const d = sign(h);
      if (d !== sign(gap)) return sig(0, 0, 'MACD and EMAs disagree');
      return sig(d, squash(Math.abs(h) / atr, 0.12) * clamp(a / 40, 0.4, 1), `MACD hist ${h > 0 ? '+' : ''}${(h / atr).toFixed(2)} ATR · ADX ${a.toFixed(0)}`);
    },

    // Bollinger Reverter: closes at or beyond a band with RSI confirming, only in ranging markets.
    mean(F, i, p) {
      const b = F.bb(p.period, p.k), r = F.rsi(14)[i], a = F.adx(14).adx[i];
      const pb = b.pctB[i];
      if (![pb, r, a].every(fin)) return NEUTRAL;
      if (a > p.adxMax) return sig(0, 0, `ADX ${a.toFixed(0)}: trending, no reversion`);
      if (pb < 0 || (pb <= 0.1 && r <= p.rsiLo)) return sig(1, squash(0.1 - pb, 0.15) * 0.6 + squash(p.rsiLo - r, 8) * 0.4, `%B ${pb.toFixed(2)} · RSI ${r.toFixed(0)}`);
      if (pb > 1 || (pb >= 0.9 && r >= p.rsiHi)) return sig(-1, squash(pb - 0.9, 0.15) * 0.6 + squash(r - p.rsiHi, 8) * 0.4, `%B ${pb.toFixed(2)} · RSI ${r.toFixed(0)}`);
      return sig(0, 0, `%B ${pb.toFixed(2)} inside bands`);
    },

    // Squeeze Breakout: Bollinger bands inside Keltner channels recently, then a close beyond a band.
    brkt(F, i, p) {
      const b = F.bb(20, 2), kc = F.kc(20, p.kcMult), atr = F.atr(14)[i], c = F.c[i];
      if (i < p.recent + 1 || ![b.up[i], b.lo[i], atr].every(fin)) return NEUTRAL;
      let squeezed = false;
      for (let j = i - p.recent; j < i; j++) if (b.up[j] < kc.up[j] && b.lo[j] > kc.lo[j]) { squeezed = true; break; }
      if (!squeezed) return sig(0, 0, 'no recent squeeze');
      const d = c > b.up[i] ? 1 : c < b.lo[i] ? -1 : 0;
      if (!d) return sig(0, 0, 'squeeze on, no break yet');
      let confirm;
      if (F.hasVolume) {
        const vz = F.volZ(20)[i];
        confirm = fin(vz) && vz >= p.volZ;
        if (!confirm) return sig(0, 0, 'break without volume');
      } else {
        confirm = d > 0 ? c > F.donHi(20)[i] : c < F.donLo(20)[i];
        if (!confirm) return sig(0, 0, 'break inside 20-day range');
      }
      const beyond = d > 0 ? c - b.up[i] : b.lo[i] - c;
      const tight = 1 - (F.bwRank(20, 2, 120)[i] ?? 0.5);
      return sig(d, squash(beyond / atr, 0.4) * 0.6 + tight * 0.4, `squeeze break ${d > 0 ? 'up' : 'down'}${F.hasVolume ? ` · vol z ${F.volZ(20)[i].toFixed(1)}` : ''}`);
    },

    // VWAP Reversion: stretched far from the 20-day VWAP in a range → revert; pullback to it in a trend → rejoin.
    vwap(F, i, p) {
      const vw = F.vwap(p.period)[i], atr = F.atr(14)[i], ax = F.adx(14);
      if (![vw, atr, ax.adx[i]].every(fin)) return NEUTRAL;
      const dev = (F.c[i] - vw) / atr;
      if (ax.adx[i] >= 25) {
        const up = ax.pdi[i] > ax.mdi[i];
        if (up && dev > -0.6 && dev < 0.3) return sig(1, squash(ax.adx[i] - 20, 15) * 0.7, `uptrend pullback to VWAP (${dev.toFixed(2)} ATR)`);
        if (!up && dev < 0.6 && dev > -0.3) return sig(-1, squash(ax.adx[i] - 20, 15) * 0.7, `downtrend rally to VWAP (${dev.toFixed(2)} ATR)`);
        return sig(0, 0, `trend, ${dev.toFixed(2)} ATR from VWAP`);
      }
      if (Math.abs(dev) >= p.devThr) return sig(-sign(dev), squash(Math.abs(dev) - p.devThr + 0.5, 1), `${dev.toFixed(2)} ATR from VWAP${F.hasVolume ? '' : ' (no volume: typical-price avg)'}`);
      return sig(0, 0, `${dev.toFixed(2)} ATR from VWAP`);
    },

    // Volatility Regime: expanding volatility below the 50-day average = risk-off; contracting above it = risk-on.
    vol(F, i, p) {
      const ap = F.atrPct(14), m50 = F.sma(50)[i];
      if (i < p.lookback || ![ap[i], ap[i - p.lookback], m50].every(fin)) return NEUTRAL;
      const ratio = ap[i] / ap[i - p.lookback];
      const above = F.c[i] > m50;
      if (ratio >= p.expand && !above) return sig(-1, squash(Math.log(ratio / p.expand) + 0.1, 0.25), `ATR up ${pct(ratio - 1)} below 50d avg`);
      if (ratio <= p.contract && above) return sig(1, squash(Math.log(p.contract / ratio) + 0.1, 0.25), `ATR down ${pct(1 - ratio)} above 50d avg`);
      return sig(0, 0, `ATR change ${pct(ratio - 1)}`);
    },

    // Return Skew: lottery-like positive skew tends to underperform and crash-prone negative skew tends to
    // be paid for (Bali, Cakici & Whitelaw 2011; Boyer, Mitton & Vorkink 2010). A fattening left tail
    // (recent downside deviation well above normal) cancels the BUY side.
    skew(F, i, p) {
      const sk = F.skew(p.window)[i], dS = F.ddev(p.window)[i], dL = F.ddev(60)[i];
      if (![sk, dS, dL].every(fin) || dL === 0) return NEUTRAL;
      const ddRatio = dS / dL;
      if (sk >= p.thr) return sig(-1, squash(sk - p.thr + 0.2, 0.6), `skew +${sk.toFixed(2)}: lottery-like`);
      if (sk <= -p.thr && ddRatio < 1.3) return sig(1, squash(-sk - p.thr + 0.2, 0.6), `skew ${sk.toFixed(2)}: crash-risk premium`);
      return sig(0, 0, `skew ${sk.toFixed(2)} · downside ${ddRatio.toFixed(2)}× normal`);
    },

    // Money Flow: Chaikin money flow (close location × volume), confirmed by on-balance-volume trend.
    flow(F, i, p) {
      const cmf = F.cmf(p.period)[i];
      if (!fin(cmf)) return NEUTRAL;
      if (Math.abs(cmf) < p.cmfThr) return sig(0, 0, `CMF ${cmf.toFixed(2)}`);
      let s = squash(Math.abs(cmf) - p.cmfThr + 0.05, 0.15);
      let note = `${F.hasVolume ? 'CMF' : 'close location (no volume)'} ${cmf.toFixed(2)}`;
      if (F.hasVolume) {
        const ob = F.obv(), o10 = sma(ob.slice(Math.max(0, i - 40), i + 1), 10), o30 = sma(ob.slice(Math.max(0, i - 40), i + 1), 30);
        const a = o10[o10.length - 1], b = o30[o30.length - 1];
        if (fin(a) && fin(b)) {
          if (sign(a - b) === sign(cmf)) note += ' · OBV agrees'; else { s *= 0.5; note += ' · OBV disagrees'; }
        }
        const mf = F.mfi(14)[i];
        if (fin(mf) && ((cmf > 0 && mf > 85) || (cmf < 0 && mf < 15))) { s *= 0.6; note += ` · MFI ${mf.toFixed(0)} stretched`; }
      }
      return sig(sign(cmf), s, note);
    },

    // Range Contraction: narrowest range in N days (or an inside day) with low ATR — an expansion is due;
    // direction from where the bar closed and the 20-day EMA slope.
    mm(F, i, p) {
      const tr = F.tr(), rank = F.atrRank(14, 120)[i], e = F.ema(20);
      if (i < p.nr || ![rank, e[i], e[i - 5]].every(fin)) return NEUTRAL;
      const range = F.h[i] - F.l[i];
      let nr = true;
      for (let j = i - p.nr + 1; j < i; j++) if (F.h[j] - F.l[j] <= range) { nr = false; break; }
      const inside = F.h[i] <= F.h[i - 1] && F.l[i] >= F.l[i - 1];
      if (!(nr || inside) || rank > p.atrRank) return sig(0, 0, 'no contraction');
      const loc = F.clv()[i], slope = (e[i] - e[i - 5]) / e[i - 5];
      const d = loc > 0.2 && slope > 0 ? 1 : loc < -0.2 && slope < 0 ? -1 : 0;
      if (!d) return sig(0, 0, `${nr ? `NR${p.nr}` : 'inside day'}, no direction`);
      return sig(d, (1 - rank) * 0.5 + squash(Math.abs(loc), 0.6) * 0.4, `${nr ? `NR${p.nr}` : 'inside day'} · ATR rank ${(rank * 100).toFixed(0)}%`);
    },

    // Relative Strength: 20-day return vs same-sector peers; leaders above their 50-day average keep leading.
    // When relative strength is neutral, a sharp sector move the stock lagged signals catch-up.
    corr(F, i, p, U, sym) {
      if (!U) return NEUTRAL;
      const g = i + U.off[sym], sec = U.sectorOf[sym] || 'Other';
      const r20 = F.rN(p.period)[i], m50 = F.sma(50)[i];
      const S = U.ctx.sectorR20[sec], S1 = U.ctx.sectorR1[sec];
      if (![r20, m50].every(fin) || S.cnt[g] < 2) return NEUTRAL;
      const peer20 = (S.sum[g] - r20) / (S.cnt[g] - 1);
      const rs = r20 - peer20;
      if (rs >= p.rsThr && F.c[i] > m50) return sig(1, squash(rs - p.rsThr + 0.01, 0.05), `+${pct(rs)} vs sector (20d)`);
      if (rs <= -p.rsThr && F.c[i] < m50) return sig(-1, squash(-rs - p.rsThr + 0.01, 0.05), `${pct(rs)} vs sector (20d)`);
      const r1 = F.ret()[i];
      if (fin(r1) && S1.cnt[g] >= 3) {
        const peer1 = (S1.sum[g] - r1) / (S1.cnt[g] - 1);
        const vol = F.vol(20)[i] / Math.sqrt(252);
        if (fin(vol) && vol > 0 && Math.abs(peer1) > 1.5 * vol && Math.abs(r1) < Math.abs(peer1) * 0.3) {
          return sig(sign(peer1), squash(Math.abs(peer1) / vol - 1.5, 1.5) * 0.6, `lagged a ${pct(peer1)} sector move`);
        }
      }
      return sig(0, 0, `${pct(rs)} vs sector`);
    },

    // Pairs Spread: z-score of the log-price spread against the most-correlated sector peer.
    pair(F, i, p, U, sym) {
      if (!U) return NEUTRAL;
      const best = pairFor(U, sym, i);
      if (!best || best.corr < 0.5) return sig(0, 0, 'no correlated peer');
      const fb = U.F[best.peer], ob = U.off[sym] - U.off[best.peer];
      const n = p.lookback;
      if (i - n + 1 < 0 || i + ob - n + 1 < 0) return NEUTRAL;
      const la = [], lb = [];
      for (let j = i - n + 1; j <= i; j++) { la.push(Math.log(F.c[j])); lb.push(Math.log(fb.c[j + ob])); }
      const ma = la.reduce((s, x) => s + x, 0) / n, mb = lb.reduce((s, x) => s + x, 0) / n;
      let cov = 0, vb = 0;
      for (let k = 0; k < n; k++) { cov += (la[k] - ma) * (lb[k] - mb); vb += (lb[k] - mb) ** 2; }
      const beta = vb > 0 ? cov / vb : 1;
      const spread = la.map((x, k) => x - beta * lb[k]);
      const sm = spread.reduce((s, x) => s + x, 0) / n;
      const sd = Math.sqrt(spread.reduce((s, x) => s + (x - sm) ** 2, 0) / n);
      if (!(sd > 0)) return NEUTRAL;
      const z = (spread[n - 1] - sm) / sd;
      if (Math.abs(z) >= p.zEntry) return sig(-sign(z), squash(Math.abs(z) - p.zEntry + 0.3, 0.8) * clamp(best.corr, 0.5, 1), `spread z ${z.toFixed(2)} vs ${best.peer} (ρ ${best.corr.toFixed(2)})`);
      return sig(0, 0, `spread z ${z.toFixed(2)} vs ${best.peer}`);
    },

    // Market Breadth: share of the universe above its 50-day average, with the equal-weight index trend.
    macr(F, i, p, U, sym) {
      if (!U) return NEUTRAL;
      const g = i + U.off[sym];
      const b50 = U.ctx.breadth50[g], b200 = U.ctx.breadth200[g];
      const idx = U.ctx.mktIdx[g], m = U.ctx.mktSma50[g];
      if (![b50, idx, m].every(fin)) return NEUTRAL;
      const agree200 = fin(b200) ? (b200 - 0.5) : 0;
      if (b50 >= p.hi && idx > m) return sig(1, squash(b50 - p.hi + 0.05 + Math.max(0, agree200) * 0.5, 0.12), `${(b50 * 100).toFixed(0)}% above 50d · index above avg`);
      if (b50 <= p.lo && idx < m) return sig(-1, squash(p.lo - b50 + 0.05 + Math.max(0, -agree200) * 0.5, 0.12), `${(b50 * 100).toFixed(0)}% above 50d · index below avg`);
      return sig(0, 0, `${(b50 * 100).toFixed(0)}% above 50d`);
    },

    // Trend Persistence: 6-month return excluding the most recent month, scaled by volatility.
    earn(F, i, p) {
      const lb = Math.min(p.lookback, i - 1);
      if (lb < p.skip + 40) return NEUTRAL;
      const r = F.c[i - p.skip] / F.c[i - lb] - 1;
      const vol = F.vol(60)[i];
      if (![r, vol].every(fin) || vol <= 0) return NEUTRAL;
      const ra = r / (vol * Math.sqrt((lb - p.skip) / 252));
      if (Math.abs(ra) < p.thr) return sig(0, 0, `${pct(r)} over ${lb - p.skip}d (risk-adj ${ra.toFixed(2)})`);
      return sig(sign(ra), squash(Math.abs(ra) - p.thr + 0.2, 0.8), `${pct(r)} over ${lb - p.skip}d, skipping last ${p.skip}d`);
    },

    // Risk-Adjusted Return: annualised 60-day Sortino ratio.
    fund(F, i, p) {
      const s = F.sortino(p.period)[i];
      if (!fin(s)) return NEUTRAL;
      if (Math.abs(s) < p.thr) return sig(0, 0, `Sortino ${s.toFixed(2)}`);
      return sig(sign(s), squash(Math.abs(s) - p.thr + 0.3, 1.5), `Sortino ${s.toFixed(2)} (${p.period}d)`);
    },

    // Gap Reactor: an opening gap of ≥ gapThr ATR in the last 3 days. Holding the gap on high volume
    // (or with no volume, holding it into the close) = continuation; filling over half of it = reversal.
    news(F, i, p) {
      const atr = F.atr(14);
      for (let back = 0; back < 3; back++) {
        const j = i - back;
        if (j < 1 || !fin(atr[j - 1])) return NEUTRAL;
        const gap = (F.o[j] - F.c[j - 1]) / atr[j - 1];
        if (Math.abs(gap) < p.gapThr) continue;
        const d = sign(gap);
        const filled = (F.c[i] - F.c[j - 1]) / (F.o[j] - F.c[j - 1]); // 1 = still at the gap open, 0 = fully filled
        const decay = 1 - back * 0.25;
        if (filled < 0.5) return sig(-d, squash(Math.abs(gap) - p.gapThr + 0.3, 1) * decay * 0.8, `${gap > 0 ? 'up' : 'down'} gap ${Math.abs(gap).toFixed(1)} ATR filling`);
        const vz = F.volZ(20)[j];
        const strongVol = F.hasVolume ? fin(vz) && vz >= p.volZ : F.clv()[j] * d > 0.3;
        if (strongVol) return sig(d, squash(Math.abs(gap) - p.gapThr + 0.3, 1) * decay, `${gap > 0 ? 'up' : 'down'} gap ${Math.abs(gap).toFixed(1)} ATR holding${F.hasVolume ? ` · vol z ${vz.toFixed(1)}` : ''}`);
        return sig(0, 0, 'gap without follow-through');
      }
      return sig(0, 0, 'no recent gap');
    },

    // Attention: abnormal volume (or, with no volume, an outsized range) on a decisive day → follow-through.
    soc(F, i, p) {
      const atr = F.atr(14)[i - 1], r = F.c[i] - F.c[i - 1];
      if (i < 1 || !fin(atr) || atr <= 0) return NEUTRAL;
      const move = r / atr;
      let surge, note;
      if (F.hasVolume) {
        const vz = F.volZ(20)[i];
        if (!fin(vz)) return NEUTRAL;
        surge = vz - p.volThr;
        note = `volume z ${vz.toFixed(1)}`;
      } else {
        const trx = F.tr()[i] / atr;
        surge = trx - p.volThr;
        note = `range ${trx.toFixed(1)}× ATR (no volume)`;
      }
      if (surge < 0 || Math.abs(move) < 0.5) return sig(0, 0, note);
      return sig(sign(move), squash(surge + 0.3, 1) * 0.6 + squash(Math.abs(move) - 0.5, 1) * 0.4, `${note} · ${move > 0 ? 'up' : 'down'} ${Math.abs(move).toFixed(1)} ATR`);
    },

    // Pattern Memory: the k most similar past setups (on standardised indicator readings) and what the
    // next `horizon` days did, plus engulfing / hammer / shooting-star candles.
    patt(F, i, p) {
      const H = p.horizon, K = p.k;
      const fv = pattFeatures(F);
      if (!fv[i]) return NEUTRAL;
      const lo = Math.max(0, i - 750);
      const cand = [];
      for (let j = lo; j + H < i; j++) {
        if (!fv[j]) continue;
        let d = 0;
        for (let k = 0; k < fv[i].length; k++) d += (fv[i][k] - fv[j][k]) ** 2;
        cand.push([d, j]);
      }
      if (cand.length < K * 4) return NEUTRAL;
      cand.sort((a, b) => a[0] - b[0]);
      let sum = 0, up = 0;
      for (let k = 0; k < K; k++) {
        const j = cand[k][1];
        const fr = F.c[j + H] / F.c[j] - 1;
        sum += fr; if (fr > 0) up++;
      }
      const pred = sum / K;
      const vol = F.vol(20)[i] / Math.sqrt(252) * Math.sqrt(H);
      let candle = 0, cNote = '';
      const o = F.o, h = F.h, l = F.l, c = F.c;
      const body = Math.abs(c[i] - o[i]), rng = h[i] - l[i];
      if (rng > 0) {
        if (c[i] > o[i] && c[i - 1] < o[i - 1] && c[i] >= o[i - 1] && o[i] <= c[i - 1]) { candle = 1; cNote = ' · bullish engulfing'; }
        else if (c[i] < o[i] && c[i - 1] > o[i - 1] && c[i] <= o[i - 1] && o[i] >= c[i - 1]) { candle = -1; cNote = ' · bearish engulfing'; }
        else if (body < rng * 0.35 && Math.min(o[i], c[i]) - l[i] > 2 * body && h[i] - Math.max(o[i], c[i]) < body) { candle = 1; cNote = ' · hammer'; }
        else if (body < rng * 0.35 && h[i] - Math.max(o[i], c[i]) > 2 * body && Math.min(o[i], c[i]) - l[i] < body) { candle = -1; cNote = ' · shooting star'; }
      }
      if (!fin(vol) || vol <= 0) return NEUTRAL;
      const z = pred / vol + candle * 0.15;
      const agree = Math.abs(up / K - 0.5) * 2;
      if (Math.abs(z) < 0.15) return sig(0, 0, `analogs ${pct(pred)} over ${H}d${cNote}`);
      return sig(sign(z), squash(Math.abs(z), 0.5) * (0.5 + 0.5 * agree), `${K} analogs avg ${pct(pred)} next ${H}d (${up}/${K} up)${cNote}`);
    },
  };

  // Feature vectors for Pattern Memory (cached per symbol). Each reading is centred and scaled with
  // fixed constants rather than statistics of the whole series, so no future data leaks in.
  function pattFeatures(F) {
    if (F._patt) return F._patt;
    const b = F.bb(20, 2), r = F.rsi(14), m = F.macd(12, 26, 9), a = F.adx(14).adx, atr = F.atr(14);
    const r5 = F.rN(5), r20 = F.rN(20), vol = F.vol(20), bwr = F.bwRank(20, 2, 120), vz = F.volZ(20);
    F._patt = [];
    for (let i = 0; i < F.n; i++) {
      const dv = vol[i] / Math.sqrt(252);
      const row = [
        (b.pctB[i] - 0.5) / 0.35, (r[i] - 50) / 12, m.hist[i] / atr[i] / 0.25, (a[i] - 25) / 10,
        r5[i] / (dv * Math.sqrt(5)), r20[i] / (dv * Math.sqrt(20)), (bwr[i] - 0.5) / 0.3,
        F.hasVolume && fin(vz[i]) ? vz[i] : 0,
      ];
      F._patt.push(row.every(fin) ? row : null);
    }
    return F._patt;
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

  // ── Walk-forward portfolio backtest ────────────────────────────────────────
  // Signals at day g's close, entries at day g+1's open, ATR stops/targets checked against each day's
  // high/low (stop assumed first if both are hit), time stop after maxHold days.
  function runBacktest(U, o = {}) {
    const ids = o.ids || AGENT_IDS;
    const signalsAt = o.signalsAt || ((sym, i) => agentSignals(U, sym, i, o.params));
    const start = Math.max(o.start ?? 0, 60), end = Math.min(o.end ?? U.L - 1, U.L - 1);
    const capital = o.capital ?? 100000, slip = o.slip ?? 0.0005;
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
        const ens = ensemble(sigs, weights, { ids, enabled: o.enabled, regimeMult: rm, corrAdj });
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

  // ── Synthetic market (SIMULATED mode) ──────────────────────────────────────
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
    AGENT_IDS, DEFAULT_PARAMS, mergeParams, agentSignals, AGENT_FNS,
    ensemble, correlationAdjust, regimeMultipliers, atrPlan,
    runBacktest, evaluateAgents, synthUniverseBars,
  };
  root.ShoalSignals = api;
})(typeof window !== 'undefined' ? window : globalThis);

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
  function trendScore(F, i, p = DEFAULT_PARAMS.earn) {
    const lb = p.lookback ?? 126, skip = p.skip ?? 21;
    return i >= lb ? F.c[i - skip] / F.c[i - lb] - 1 : NaN;
  }

  function monthEnd(U, g) {
    for (const s of U.syms) {
      const F = U.F[s], i = g - U.off[s];
      if (F.t && F.t[i] && F.t[i + 1]) return String(F.t[i]).slice(0, 7) !== String(F.t[i + 1]).slice(0, 7);
      if (F.t && F.t[i] && !F.t[i + 1]) return false;
    }
    return null; // no dates: caller falls back to every 21 bars
  }

  function runTilt(U, o = {}) {
    const start = Math.max(o.start ?? 130, 130), end = Math.min(o.end ?? U.L - 1, U.L - 1);
    const capital = o.capital ?? 100000, cost = costOf(o), frac = o.investFraction ?? 1;
    const N = U.syms.length, K = Math.max(1, Math.min(N, o.topK ?? Math.ceil(N / 2)));
    const scoreAt = o.scoreAt || ((sym, i) => trendScore(U.F[sym], i, mergeParams(o.params).earn));
    let cash = capital;
    const pos = {}; // sym → { qty, entry, entryG }
    const trades = [], curve = [], bench = [], days = [], picks = [];
    let orders = null, traded = 0, invSum = 0, rebalances = 0;
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
      const rebalance = g === start || (me == null ? (g - start) % 21 === 0 : me);
      if (!rebalance) continue;
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
    momo: { id: 'adxMin',   values: [15, 18, 20, 23, 25, 30] },
    mean: { id: 'k',        values: [1.6, 1.8, 2.0, 2.2, 2.5] },
    brkt: { id: 'kcMult',   values: [1.0, 1.25, 1.5, 1.75, 2.0] },
    vwap: { id: 'devThr',   values: [1.0, 1.25, 1.5, 2.0, 2.5] },
    vol:  { id: 'expand',   values: [1.1, 1.2, 1.25, 1.35, 1.5] },
    skew: { id: 'thr',      values: [0.3, 0.5, 0.7, 0.9, 1.2] },
    flow: { id: 'cmfThr',   values: [0.05, 0.08, 0.1, 0.15, 0.2] },
    mm:   { id: 'atrRank',  values: [0.15, 0.2, 0.3, 0.4, 0.5] },
    corr: { id: 'rsThr',    values: [0.015, 0.02, 0.03, 0.04, 0.06] },
    pair: { id: 'zEntry',   values: [1.5, 1.75, 2.0, 2.5, 3.0] },
    macr: { id: 'hi',       values: [0.55, 0.6, 0.65, 0.7, 0.75] },
    earn: { id: 'lookback', values: [63, 84, 126, 168, 210] },
    fund: { id: 'thr',      values: [0.5, 0.75, 1.0, 1.5, 2.0] },
    news: { id: 'gapThr',   values: [0.5, 0.75, 1.0, 1.25, 1.5] },
    soc:  { id: 'volThr',   values: [1.5, 1.75, 2.0, 2.5, 3.0] },
    patt: { id: 'k',        values: [5, 8, 10, 15, 20] },
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
        : cfg.agents === 'default' ? (cfg.style === 'both' ? 1 / AGENT_IDS.length : (id === 'earn' ? 1 : 0))
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
    AGENT_IDS, DEFAULT_PARAMS, mergeParams, agentSignals, AGENT_FNS,
    ensemble, correlationAdjust, regimeMultipliers, atrPlan,
    runBacktest, evaluateAgents, synthUniverseBars,
    TUNE_KEYS, AUTOPILOT, createScoreBook, proposeWeights, tuneParam, runInvested,
    OPT_SPACE, OPT_WARMUP, configWeights, configParams, createEvaluator, optimiseSettings, compareSettings,
    COST_PROFILES, trendScore, runTilt, MODEL, fitModel, modelScore, rankIC, agentEvidence, createModelScorer,
  };
  root.ShoalSignals = api;
})(typeof window !== 'undefined' ? window : globalThis);

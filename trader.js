// Server-side Rank & tilt: run once a day by a Vercel cron job, so the strategy trades without a browser.
//
// Each run (market open only):
//   1. ranks the watchlist by the trend score as of the last trading day of the previous month, so the
//      picks are fixed for the whole month whichever day the job runs;
//   2. sells any position not among the picks;
//   3. buys picks it doesn't hold with an equal share of equity × investFraction / K, spending only cash
//      the account already has — while sells are still settling it waits for a full share.
// Running it again the same day or month is harmless: it only acts on what's still out of line, which
// also finishes a re-rank that couldn't complete in one go. The job treats the account as its own: it
// sells anything held that isn't a pick.
import fs from 'fs';
import vm from 'vm';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let LIBS = null;
function libs() {
  if (LIBS) return LIBS;
  const box = {};
  for (const f of ['watchlist.js', 'signals.js']) vm.runInNewContext(fs.readFileSync(path.join(HERE, f), 'utf8'), box, { filename: f });
  LIBS = { S: box.ShoalSignals, W: box.ShoalWatchlist };
  return LIBS;
}

// New York calendar month of a date (the market's own month)
const nyMonth = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit' }).format(d).slice(0, 7);
const num = (x) => (x == null ? NaN : parseFloat(x));

export function serverConfig(env = process.env) {
  const { W } = libs();
  const list = (env.SHOAL_WATCHLIST || '').toUpperCase().split(/[^A-Z0-9.]+/).filter(Boolean);
  return {
    keyId: env.ALPACA_KEY_ID || '',
    secret: env.ALPACA_SECRET || '',
    env: env.ALPACA_ENV === 'live' ? 'live' : 'paper',
    liveAllowed: env.SHOAL_SERVER_LIVE === '1',
    topK: Math.max(1, Math.min(50, parseInt(env.SHOAL_TOPK, 10) || 12)),
    investFraction: Math.max(0.1, Math.min(1, parseFloat(env.SHOAL_INVEST_FRACTION) || 0.9)),
    watchlist: (list.length >= 5 ? list : W.DEFAULT).slice(0, 150),
    dailyLossPct: Math.max(1, Math.min(50, parseFloat(env.SHOAL_DAILY_LOSS_PCT) || 5)),
    schedule: 'every trading day: open review 15 min after the open, hourly checks, end-of-day report',
  };
}

// Picks for the month of `now`: trend score at each stock's last bar before this month
export function pickFor(barsBySym, { topK, now = new Date() }) {
  const { S } = libs();
  const month = nyMonth(now);
  const U = S.buildUniverse(barsBySym, {});
  const scored = [];
  let asOf = null;
  for (const sym of U.syms) {
    const F = U.F[sym];
    let i = F.n - 1;
    while (i >= 0 && String(F.t[i]).slice(0, 7) >= month) i--;
    if (i < 130) continue;
    const sc = S.trendScore(F, i);
    if (Number.isFinite(sc)) { scored.push({ sym, score: sc }); if (!asOf || String(F.t[i]) > asOf) asOf = String(F.t[i]).slice(0, 10); }
  }
  scored.sort((a, b) => b.score - a.score);
  const K = S.effectiveTopK(topK, scored.length);
  return { month, asOf, ranked: scored, picks: scored.slice(0, K).map(x => x.sym), K };
}

// One run against an Alpaca session. dry = plan only, no orders.
export async function runTilt(session, cfg, { dry = false, now = new Date() } = {}) {
  const clock = await session.req('/v2/clock');
  const isOpen = !!clock.body?.is_open;
  if (!isOpen && !dry) return { ok: true, skipped: 'market closed', nextOpen: clock.body?.next_open || null };
  const bars = await session.bars(cfg.watchlist, 420);
  if (bars.status !== 200) return { ok: false, error: `bars: HTTP ${bars.status}` };
  const plan = pickFor(bars.body.bars || {}, { topK: cfg.topK, now });
  if (!plan.picks.length) return { ok: false, error: 'not enough price history to rank the watchlist' };
  const [acct, pos] = await Promise.all([session.account(), session.positions()]);
  if (acct.status !== 200 || pos.status !== 200) return { ok: false, error: 'could not read the account' };
  const pick = new Set(plan.picks);
  const held = new Map((Array.isArray(pos.body) ? pos.body : []).map(p => [p.symbol, num(p.market_value)]));
  const sells = [...held.keys()].filter(s => !pick.has(s));
  const missing = plan.picks.filter(s => !held.has(s));
  const equity = num(acct.body.equity), cash = Math.min(num(acct.body.cash), num(acct.body.buying_power));
  const per = (equity * cfg.investFraction) / plan.K;
  const buys = [];
  let left = Number.isFinite(cash) ? cash : 0;
  for (const sym of missing) {
    if (sells.length && left < per * 0.95) break; // sells still settling: wait for a full share
    const notional = Math.floor(Math.min(per, left) * 100) / 100;
    if (notional < 1) break;
    buys.push({ sym, notional });
    left -= notional;
  }
  const result = { ok: true, dry, marketOpen: isOpen, month: plan.month, rankedAsOf: plan.asOf, K: plan.K, picks: plan.picks,
    held: [...held.keys()], sells, buys, waiting: missing.filter(s => !buys.some(b => b.sym === s)), equity, cash, perPosition: Math.round(per * 100) / 100, orders: [] };
  if (dry || !isOpen) return result;
  for (const sym of sells) {
    const r = await session.closePosition(sym);
    result.orders.push({ sym, side: 'sell', status: r.status, ok: r.status === 200, message: r.body?.message });
  }
  for (const b of buys) {
    const r = await session.placeOrder({ symbol: b.sym, notional: b.notional.toFixed(2), side: 'buy', type: 'market', time_in_force: 'day' });
    result.orders.push({ sym: b.sym, side: 'buy', notional: b.notional, status: r.status, ok: r.status === 200, message: r.body?.message });
  }
  return result;
}

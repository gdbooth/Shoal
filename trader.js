// Server-side strategies run by the engine (engine.js): the 9-agent team (default) and Rank & tilt
// (SHOAL_STRATEGY=tilt). Rank & tilt:
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
import { notifyConfig } from './notify.js';

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
    strategy: env.SHOAL_STRATEGY === 'tilt' ? 'tilt' : 'team',
    notify: notifyConfig(env),
    stopPct: Math.max(0, Math.min(50, parseFloat(env.SHOAL_STOP_PCT) || 0)),
    marketDropPct: Math.max(0.5, Math.min(20, parseFloat(env.SHOAL_MARKET_DROP_PCT) || 3)),
    staleMin: Math.max(5, Math.min(240, parseInt(env.SHOAL_STALE_MIN, 10) || 30)),
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

// ── The 9-agent team (default strategy from step 2) ─────────────────────────────────────────────────
// Each run (market open only):
//   1. builds the universe from completed daily bars (today's unfinished bar is dropped, so the open
//      review and every hourly check see the same data and the same votes all day);
//   2. asks the 9 agents for their votes on every watched stock and applies the team rule
//      (S.teamDecision): SELL a holding when a majority of the 7 pickers turns against it or the risk
//      guardian sees serious danger; BUY a stock a majority backs with enough confidence, while the
//      market-trend agent isn't strongly negative;
//   3. sells holdings that are no longer on the watchlist;
//   4. buys the best-scored BUYs it doesn't hold, up to topK positions, each equity × investFraction / topK
//      (halved while the market trend is negative), spending only cash it already has.
// Every decision (votes per agent, score, confidence) is returned so step 3 can score each call later.
const BARS_DAYS = 600, LEARN_DAYS = 820;
const nyDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

export function teamPlan(barsBySym, { held = [], watchlist, topK, now = new Date(), params, decision, weights } = {}) {
  const { S, W } = libs();
  const today = nyDate(now);
  const sectors = Object.fromEntries(W.CATALOG.map(r => [r[0], r[2]]));
  const done = {};
  for (const [sym, arr] of Object.entries(barsBySym || {})) {
    const a = (arr || []).filter(b => String(b.t).slice(0, 10) < today);
    if (a.length) done[sym] = a;
  }
  const U = S.buildUniverse(done, sectors);
  const heldSet = new Set(held), watch = new Set(watchlist || U.syms);
  const decisions = [];
  let asOf = null, mkt = 0;
  for (const sym of U.syms) {
    const F = U.F[sym], i = F.n - 1;
    if (i < 130) continue;
    const sg = S.agentSignals(U, sym, i, params);
    const d = S.teamDecision(sg, { held: heldSet.has(sym), weights, ...(decision || {}) });
    mkt = d.mkt;
    const day = String(F.t[i]).slice(0, 10);
    if (!asOf || day > asOf) asOf = day;
    decisions.push({ sym, action: d.action, why: d.why, score: Math.round(d.score * 1000) / 1000, confidence: Math.round(d.confidence * 1000) / 1000,
      forVotes: d.forVotes, againstVotes: d.againstVotes, votes: Object.fromEntries(Object.entries(sg).map(([id, s]) => [id, Math.round(s.dir * s.strength * 100) / 100])) });
  }
  const by = Object.fromEntries(decisions.map(d => [d.sym, d]));
  const sells = held.filter(s => !watch.has(s) || by[s]?.action === 'SELL');
  const keep = held.filter(s => !sells.includes(s));
  const room = Math.max(0, topK - keep.length);
  const cands = decisions.filter(d => d.action === 'BUY' && !heldSet.has(d.sym) && watch.has(d.sym)).sort((a, b) => b.score - a.score);
  return { asOf, mkt: Math.round(mkt * 100) / 100, scale: mkt < -0.2 ? 0.5 : 1, decisions, sells, keep, wanted: cands.slice(0, room).map(d => d.sym),
    sellWhy: Object.fromEntries(sells.map(s => [s, watch.has(s) ? by[s]?.why : 'not on the watchlist'])) };
}

export async function runTeamLive(session, cfg, { dry = false, now = new Date(), weights = null, blockBuys = null, phase = 'open' } = {}) {
  const clock = await session.req('/v2/clock');
  const isOpen = !!clock.body?.is_open;
  if (!isOpen && !dry) return { ok: true, skipped: 'market closed', nextOpen: clock.body?.next_open || null };
  const [acct, pos, open] = await Promise.all([session.account(), session.positions(), openOrders(session)]);
  if (acct.status !== 200 || pos.status !== 200) return { ok: false, error: 'could not read the account' };
  const held = (Array.isArray(pos.body) ? pos.body : []).map(p => p.symbol);
  const syms = [...new Set([...cfg.watchlist, ...held])];
  // orders still working (not filled yet): never send a second order for the same stock, and count
  // pending buys as cash already spent
  const pendingBuy = new Set(open.filter(o => o.side === 'buy').map(o => o.symbol));
  const pendingSell = new Set(open.filter(o => o.side === 'sell').map(o => o.symbol));
  const pendingCash = open.filter(o => o.side === 'buy').reduce((a, o) => a + (num(o.notional) || num(o.qty) * num(o.limit_price) || 0), 0);
  const bars = await session.bars(syms, BARS_DAYS); // ~410 trading days: momentum needs 273
  if (bars.status !== 200) return { ok: false, error: `bars: HTTP ${bars.status}` };
  const plan = teamPlan(bars.body.bars || {}, { held, watchlist: cfg.watchlist, topK: cfg.topK, now, weights });
  if (!plan.decisions.length) return { ok: false, error: 'not enough price history for the agents' };
  const equity = num(acct.body.equity), cash = Math.min(num(acct.body.cash), num(acct.body.buying_power));
  const per = (equity * cfg.investFraction * plan.scale) / cfg.topK;
  const buys = [], sells = plan.sells.filter(s => !pendingSell.has(s));
  let left = Math.max(0, (Number.isFinite(cash) ? cash : 0) - pendingCash);
  for (const sym of blockBuys ? [] : plan.wanted.filter(s => !pendingBuy.has(s))) {
    if (sells.length && left < per * 0.95) break; // sells still settling: wait for a full share
    const notional = Math.floor(Math.min(per, left) * 100) / 100;
    if (notional < 1 || notional < per * 0.5) break;
    buys.push({ sym, notional });
    left -= notional;
  }
  const count = (a) => plan.decisions.filter(d => d.action === a).length;
  const result = { ok: true, dry, strategy: 'team', weights: weights || null, marketOpen: isOpen, rankedAsOf: plan.asOf, K: cfg.topK, mkt: plan.mkt, scale: plan.scale,
    picks: [...plan.keep, ...buys.map(b => b.sym)], held, sells, buys, waiting: plan.wanted.filter(s => !buys.some(b => b.sym === s) && !pendingBuy.has(s)),
    pending: open.map(o => `${o.side} ${o.symbol}`), blockBuys: blockBuys || null,
    sellWhy: plan.sellWhy, tally: { BUY: count('BUY'), SELL: count('SELL'), HOLD: count('HOLD'), WAIT: count('WAIT') },
    decisions: plan.decisions, equity, cash, perPosition: Math.round(per * 100) / 100, orders: [] };
  if (dry || !isOpen) return result;
  for (const sym of sells) {
    const r = await session.closePosition(sym);
    result.orders.push({ sym, side: 'sell', status: r.status, ok: r.status === 200, id: r.body?.id, message: r.body?.message, why: plan.sellWhy[sym] });
  }
  for (const b of buys) {
    // a client order id unique to this day, hour and stock: a retried tick can't place the same buy twice
    const r = await session.placeOrder({ symbol: b.sym, notional: b.notional.toFixed(2), side: 'buy', type: 'market', time_in_force: 'day', client_order_id: clientId(now, phase, 'buy', b.sym) });
    result.orders.push({ sym: b.sym, side: 'buy', notional: b.notional, status: r.status, ok: r.status === 200, id: r.body?.id, message: r.body?.message });
  }
  return result;
}

// ── Orders and the hourly guardian (step 4) ─────────────────────────────────────────────────────────
const nyHour = (d) => new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' }).format(d);
export const clientId = (now, phase, side, sym) => `shoal-${nyDate(now).replace(/-/g, '')}-${nyHour(now)}-${phase}-${side}-${sym}`.slice(0, 128);

export async function openOrders(session) {
  if (!session.orders) return [];
  try { const r = await session.orders({ status: 'open' }); return r.status === 200 && Array.isArray(r.body) ? r.body : []; } catch { return []; }
}

// Cancel orders that have been working too long (a market order that hasn't filled in `staleMin` minutes
// is stuck: halted stock, rejected route). The strategy re-decides on the next check.
export async function cancelStale(session, { now = new Date(), staleMin = 30 } = {}) {
  const open = await openOrders(session), cancelled = [];
  for (const o of open) {
    const age = (now - new Date(o.submitted_at || o.created_at || now)) / 60000;
    if (age < staleMin || !session.cancelOrder) continue;
    const r = await session.cancelOrder(o.id);
    cancelled.push({ sym: o.symbol, side: o.side, ageMin: Math.round(age), ok: r.status === 200 });
  }
  return { open: open.length - cancelled.length, cancelled };
}

// Every order since the day's open review, by outcome: what filled (and at what price), what was
// rejected or cancelled and why, what is still working
export async function orderReport(session, { since } = {}) {
  if (!session.orders) return null;
  const r = await session.orders({ status: 'all', after: since, direction: 'asc', limit: '200' });
  if (r.status !== 200 || !Array.isArray(r.body)) return null;
  const mine = r.body.filter(o => String(o.client_order_id || '').startsWith('shoal-') || o.side === 'sell');
  const by = (st) => mine.filter(o => st.includes(o.status));
  const fill = (o) => ({ sym: o.symbol, side: o.side, qty: num(o.filled_qty), price: num(o.filled_avg_price), value: Math.round(num(o.filled_qty) * num(o.filled_avg_price) * 100) / 100 });
  return {
    filled: by(['filled', 'partially_filled']).map(fill),
    rejected: by(['rejected']).map(o => ({ sym: o.symbol, side: o.side })),
    cancelled: by(['canceled', 'expired']).map(o => ({ sym: o.symbol, side: o.side })),
    working: by(['new', 'accepted', 'pending_new', 'held']).map(o => ({ sym: o.symbol, side: o.side })),
  };
}

// The hourly guardian. Tested on real 2013–2026 data, selling on intraday moves (crash exits of 3–5
// daily standard deviations, stops of 10–15%) cut the team's returns: falls were usually bought back
// by the market. So the guardian doesn't sell on intraday moves. It blocks new buys while the market
// or the portfolio is falling hard, flags holdings in trouble, and sells only on an optional
// catastrophe stop (SHOAL_STOP_PCT, off by default).
export function guardCheck({ positions = [], equity, openEquity, spyDayPct = null, cfg = {} }) {
  const dayRet = openEquity > 0 && equity > 0 ? equity / openEquity - 1 : 0;
  const flags = [], stops = [];
  for (const p of positions) {
    const today = num(p.change_today), fromEntry = num(p.unrealized_plpc);
    if (today <= -(cfg.flagDayPct ?? 8) / 100) flags.push(`${p.symbol} ${(today * 100).toFixed(1)}% today`);
    if (fromEntry <= -(cfg.flagEntryPct ?? 15) / 100) flags.push(`${p.symbol} ${(fromEntry * 100).toFixed(1)}% from entry`);
    if (cfg.stopPct > 0 && fromEntry <= -cfg.stopPct / 100) stops.push(p.symbol);
  }
  let blockBuys = null;
  if (dayRet <= -(cfg.dailyLossPct ?? 5) / 100) blockBuys = `daily loss limit (${(dayRet * 100).toFixed(1)}%)`;
  else if (spyDayPct != null && spyDayPct <= -(cfg.marketDropPct ?? 3)) blockBuys = `market down ${spyDayPct.toFixed(1)}% today`;
  return { dayReturnPct: Math.round(dayRet * 10000) / 100, spyDayPct, flags, stops, blockBuys };
}

export async function spyDay(session) {
  if (!session.stockSnapshots) return null;
  try {
    const r = await session.stockSnapshots(['SPY']);
    const s = r.status === 200 ? (r.body?.SPY || r.body?.snapshots?.SPY) : null;
    const last = num(s?.latestTrade?.p) || num(s?.dailyBar?.c), prev = num(s?.prevDailyBar?.c);
    return last > 0 && prev > 0 ? Math.round((last / prev - 1) * 10000) / 100 : null;
  } catch { return null; }
}

export const STRATEGIES = { team: runTeamLive, tilt: runTilt };
export const strategyFor = (cfg) => STRATEGIES[cfg?.strategy] || runTeamLive;

// ── Learning (step 3) ───────────────────────────────────────────────────────────────────────────────
// After each close: fetch ~560 trading days of the watchlist's bars, score every agent call whose horizon
// has passed (S.learnUpdate: the first run rebuilds a year of calls from this history), move the picker
// weights a damped step and keep the scorecard. Stored in learning.json; the team reads its weights.
export async function learnFromBroker(session, cfg, store, { now = new Date() } = {}) {
  const { S, W } = libs();
  const today = nyDate(now);
  const bars = await session.bars(cfg.watchlist, LEARN_DAYS);
  if (bars.status !== 200) return { ok: false, error: `bars: HTTP ${bars.status}` };
  const done = {};
  for (const [sym, arr] of Object.entries(bars.body.bars || {})) { const a = (arr || []).filter(b => String(b.t).slice(0, 10) <= today); if (a.length) done[sym] = a; }
  const U = S.buildUniverse(done, Object.fromEntries(W.CATALOG.map(r => [r[0], r[2]])));
  if (U.L < 300) return { ok: false, error: `only ${U.L} days of history: the agents need ~300` };
  const prev = (await store.get('learning.json')) || {};
  const { scorecard, added, state, error } = S.learnUpdate(U, prev.state || {});
  if (error) return { ok: false, error };
  await store.put('learning.json', { state, scorecard, savedAt: now.toISOString() });
  return { ok: true, added, scorecard };
}
export async function learnedWeights(store) {
  try { const l = await store.get('learning.json'); return l?.state?.weights || null; } catch { return null; }
}
export function scorecardSummary(sc) {
  if (!sc) return 'no scorecard';
  const moved = sc.agents.filter(a => a.prevWeight != null && Math.abs(a.weight - a.prevWeight) >= 0.005)
    .map(a => `${a.id} ${a.prevWeight.toFixed(2)}→${a.weight.toFixed(2)}`);
  const flag = sc.agents.filter(a => a.status === 'retire candidate').map(a => a.id);
  return `scorecard ${sc.asOf}: ${sc.days} days scored` + (moved.length ? `; weights ${moved.join(', ')}` : '; weights unchanged')
    + (flag.length ? `; retire candidates: ${flag.join(', ')}` : '');
}

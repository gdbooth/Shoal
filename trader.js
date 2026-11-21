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

export async function runTeamLive(session, cfg, { dry = false, now = new Date(), weights = null } = {}) {
  const clock = await session.req('/v2/clock');
  const isOpen = !!clock.body?.is_open;
  if (!isOpen && !dry) return { ok: true, skipped: 'market closed', nextOpen: clock.body?.next_open || null };
  const [acct, pos] = await Promise.all([session.account(), session.positions()]);
  if (acct.status !== 200 || pos.status !== 200) return { ok: false, error: 'could not read the account' };
  const held = (Array.isArray(pos.body) ? pos.body : []).map(p => p.symbol);
  const syms = [...new Set([...cfg.watchlist, ...held])];
  const bars = await session.bars(syms, BARS_DAYS); // ~410 trading days: momentum needs 273
  if (bars.status !== 200) return { ok: false, error: `bars: HTTP ${bars.status}` };
  const plan = teamPlan(bars.body.bars || {}, { held, watchlist: cfg.watchlist, topK: cfg.topK, now, weights });
  if (!plan.decisions.length) return { ok: false, error: 'not enough price history for the agents' };
  const equity = num(acct.body.equity), cash = Math.min(num(acct.body.cash), num(acct.body.buying_power));
  const per = (equity * cfg.investFraction * plan.scale) / cfg.topK;
  const buys = [];
  let left = Number.isFinite(cash) ? cash : 0;
  for (const sym of plan.wanted) {
    if (plan.sells.length && left < per * 0.95) break; // sells still settling: wait for a full share
    const notional = Math.floor(Math.min(per, left) * 100) / 100;
    if (notional < 1 || notional < per * 0.5) break;
    buys.push({ sym, notional });
    left -= notional;
  }
  const count = (a) => plan.decisions.filter(d => d.action === a).length;
  const result = { ok: true, dry, strategy: 'team', weights: weights || null, marketOpen: isOpen, rankedAsOf: plan.asOf, K: cfg.topK, mkt: plan.mkt, scale: plan.scale,
    picks: [...plan.keep, ...buys.map(b => b.sym)], held, sells: plan.sells, buys, waiting: plan.wanted.filter(s => !buys.some(b => b.sym === s)),
    sellWhy: plan.sellWhy, tally: { BUY: count('BUY'), SELL: count('SELL'), HOLD: count('HOLD'), WAIT: count('WAIT') },
    decisions: plan.decisions, equity, cash, perPosition: Math.round(per * 100) / 100, orders: [] };
  if (dry || !isOpen) return result;
  for (const sym of plan.sells) {
    const r = await session.closePosition(sym);
    result.orders.push({ sym, side: 'sell', status: r.status, ok: r.status === 200, message: r.body?.message, why: plan.sellWhy[sym] });
  }
  for (const b of buys) {
    const r = await session.placeOrder({ symbol: b.sym, notional: b.notional.toFixed(2), side: 'buy', type: 'market', time_in_force: 'day' });
    result.orders.push({ sym: b.sym, side: 'buy', notional: b.notional, status: r.status, ok: r.status === 200, message: r.body?.message });
  }
  return result;
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

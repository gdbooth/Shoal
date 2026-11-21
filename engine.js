// The server engine: one source of truth for trading, driven by an external scheduler that calls
// /api/engine/tick every ~15 minutes on weekdays. Each tick asks Alpaca's market clock what is due:
//
//   open    once a day, 15+ minutes after the open: review holdings and the watchlist, place the day's orders
//   hourly  once per clock hour while the market is open (from an hour after the open): the risk guardian
//           (no new buys while the portfolio is past its daily loss limit or the market is falling hard;
//           holdings in trouble flagged; optional catastrophe stop), stuck orders cancelled, and the
//           strategy re-run to finish what the open couldn't (it never doubles an order still working)
//   close   once a day after the session ends (full or half day): end-of-day report, then the agent
//           scorecard: every call whose horizon has passed is scored and the picker weights move a damped step
//
// Decisions come from a strategy function (trader.js): the 9-agent team by default, or Rank & tilt when
// SHOAL_STRATEGY=tilt. Everything is recorded in
// the store: state.json (what ran, recent events and reports — one read for the dashboard) and
// days/YYYY-MM-DD.json (that day's full log). A tick with nothing due reads state and writes nothing.
import { notify } from './notify.js';
import { goLiveCheck, HOW_TO_GO_LIVE } from './readiness.js';
import { strategyFor, learnFromBroker, learnedWeights, scorecardSummary, guardCheck, cancelStale, orderReport, spyDay } from './trader.js';

export const ENGINE = { openDelayMin: 15, hourlyFromMin: 60, lockMs: 4 * 60_000, keepEvents: 60, keepReports: 90 };

const nyParts = (d) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(d).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour % 24, min: (+p.hour % 24) * 60 + +p.minute };
};
const num = (x) => (x == null ? NaN : parseFloat(x));
const round2 = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : null);

// Which phases are due now (pure: easy to test)
export function duePhases(state, { isOpen, now }) {
  const ny = nyParts(now), sinceOpen = ny.min - 570, due = [];
  if (isOpen) {
    if (state.lastOpenDate !== ny.date && sinceOpen >= ENGINE.openDelayMin) due.push('open');
    const hourKey = `${ny.date}T${String(ny.hour).padStart(2, '0')}`;
    if (sinceOpen >= ENGINE.hourlyFromMin && state.lastHourlyKey !== hourKey && (state.lastOpenDate === ny.date || due.includes('open'))) due.push('hourly');
  } else if (state.lastOpenDate === ny.date && state.lastCloseDate !== ny.date && sinceOpen >= 60) {
    due.push('close');
  }
  return { due, ny };
}

async function snapshot(session) {
  const [acct, pos] = await Promise.all([session.account(), session.positions()]);
  const positions = Array.isArray(pos.body) ? pos.body.map(p => ({ sym: p.symbol, qty: num(p.qty), value: round2(num(p.market_value)), upnlPct: round2(num(p.unrealized_plpc) * 100) })) : [];
  return { equity: round2(num(acct.body?.equity)), cash: round2(num(acct.body?.cash)), positions, raw: Array.isArray(pos.body) ? pos.body : [] };
}

export async function engineTick({ session, store, cfg, strategy, learn = learnFromBroker, send, now = new Date(), dry = false }) {
  send = send || ((m) => notify(cfg.notify, m));
  strategy = strategy || strategyFor(cfg);
  const clock = await session.req('/v2/clock');
  if (clock.status !== 200) return { ok: false, error: `clock: HTTP ${clock.status}` };
  const isOpen = !!clock.body.is_open;
  const state = (await store.get('state.json')) || {};
  const { due, ny } = duePhases(state, { isOpen, now });
  const base = { ok: true, at: now.toISOString(), nyDate: ny.date, marketOpen: isOpen, due };
  if (!due.length) return { ...base, ran: [] };
  if (dry) return { ...base, ran: [], dry: true };
  if (state.lockUntil && state.lockUntil > now.getTime()) return { ...base, ran: [], skipped: 'another tick is running' };
  state.lockUntil = now.getTime() + ENGINE.lockMs;
  await store.put('state.json', state);

  const dayKey = `days/${ny.date}.json`;
  const day = (await store.get(dayKey)) || { date: ny.date, events: [] };
  const events = [];
  const record = (phase, data) => { const e = { phase, at: now.toISOString(), ...data }; events.push(e); day.events.push(e); return e; };
  // notifications: collected during the tick, sent after it is saved; `key` sends an alert once per day
  const notes = [], level = cfg.notify?.level || 'daily';
  day.notified = day.notified || [];
  const note = (m, key) => { if (key) { if (day.notified.includes(key)) return; day.notified.push(key); } notes.push(m); };
  const orderText = (r) => (r?.orders || []).map(o => `${o.side} ${o.sym}${o.notional ? ` $${Math.round(o.notional).toLocaleString()}` : ''}${o.ok ? '' : ' (failed)'}`).join(', ');
  const weights = due.some(p => p !== 'close') ? await learnedWeights(store) : null;
  try {
    for (const phase of due) {
      if (phase === 'open') {
        const snap = await snapshot(session);
        day.openEquity = snap.equity;
        const r = await strategy(session, cfg, { now, weights, phase: 'open' });
        record('open', { summary: summarise(r), result: r, equity: snap.equity, positions: snap.positions.length });
        if (level === 'all' && r?.orders?.length) note({ title: 'Shoal: open review', text: `${summarise(r)}\nOrders: ${orderText(r)}`, priority: 'low', tags: ['chart_with_upwards_trend'] });
        if (r && r.ok === false) note({ title: 'Shoal: open review failed', text: r.error || 'unknown error', priority: 'high', tags: ['warning'] }, `open-error`);
        state.lastOpenDate = ny.date;
      }
      if (phase === 'hourly') {
        const snap = await snapshot(session);
        const start = day.openEquity ?? snap.equity;
        const guard = guardCheck({ positions: snap.raw, equity: snap.equity, openEquity: start, spyDayPct: await spyDay(session), cfg });
        const stale = await cancelStale(session, { now, staleMin: cfg.staleMin ?? 30 });
        const stopOrders = [];
        for (const sym of guard.stops) {
          const s = await session.closePosition(sym);
          stopOrders.push({ sym, side: 'sell', status: s.status, ok: s.status === 200, why: `catastrophe stop (${cfg.stopPct}% from entry)` });
        }
        // finish anything the open couldn't (e.g. buys waiting for sells to settle); no new buys while the guardian blocks them
        const r = guard.blockBuys && cfg.strategy === 'tilt' ? { ok: true, skipped: guard.blockBuys } : await strategy(session, cfg, { now, weights, blockBuys: guard.blockBuys, phase: 'hourly' });
        if (stopOrders.length) r.orders = [...stopOrders, ...(r.orders || [])];
        const parts = [summarise(r)];
        if (guard.blockBuys && !r.skipped) parts.push(`no new buys: ${guard.blockBuys}`);
        if (guard.flags.length) parts.push(`watch: ${guard.flags.join(', ')}`);
        if (stopOrders.length) parts.push(`stopped out: ${stopOrders.map(o => o.sym).join(', ')}`);
        if (stale.cancelled.length) parts.push(`cancelled stuck orders: ${stale.cancelled.map(o => `${o.side} ${o.sym}`).join(', ')}`);
        record('hourly', { summary: parts.join(' · '), result: r, guard, cancelled: stale.cancelled, equity: snap.equity, dayReturnPct: guard.dayReturnPct, positions: snap.positions.length });
        if (guard.blockBuys) note({ title: 'Shoal: no new buys', text: `Risk guardian: ${guard.blockBuys}. Portfolio ${guard.dayReturnPct}% today.`, priority: 'high', tags: ['shield'] }, `block-${guard.blockBuys.split(' ')[0]}`);
        for (const f of guard.flags) note({ title: 'Shoal: holding to watch', text: f, priority: 'default', tags: ['eyes'] }, `flag-${f.split(' ')[0]}-${/today/.test(f) ? 'day' : 'entry'}`);
        if (stopOrders.length) note({ title: 'Shoal: catastrophe stop', text: `Sold ${stopOrders.map(o => o.sym).join(', ')} (${cfg.stopPct}% below entry).`, priority: 'high', tags: ['rotating_light'] });
        if (level === 'all' && r?.orders?.length) note({ title: 'Shoal: hourly check', text: `Orders: ${orderText(r)}`, priority: 'low' });
        state.lastHourlyKey = `${ny.date}T${String(ny.hour).padStart(2, '0')}`;
      }
      if (phase === 'close') {
        const snap = await snapshot(session);
        const start = day.openEquity ?? snap.equity;
        let spyPct = null;
        try {
          const b = await session.bars(['SPY'], 10);
          const s = b.body?.bars?.SPY || [];
          const last = s[s.length - 1], prev = s[s.length - 2];
          if (last && prev && String(last.t).slice(0, 10) === ny.date) spyPct = round2((last.c / prev.c - 1) * 100);
        } catch { /* benchmark is optional */ }
        let orders = null;
        try { orders = await orderReport(session, { since: (day.events[0] && day.events[0].at) || new Date(now - 8 * 3600e3).toISOString() }); } catch { /* optional */ }
        const report = { date: ny.date, equityOpen: start, equityClose: snap.equity, dayReturnPct: start > 0 ? round2((snap.equity / start - 1) * 100) : null, spyPct,
          positions: snap.positions, trades: day.events.reduce((n, e) => n + ((e.result && e.result.orders) || []).length, 0),
          fills: orders ? orders.filled.length : null, rejected: orders ? orders.rejected.length : null, orders };
        day.report = report;
        const ord = orders ? ` (${orders.filled.length} filled${orders.rejected.length ? `, ${orders.rejected.length} rejected: ${orders.rejected.map(o => o.sym).join(', ')}` : ''}${orders.cancelled.length ? `, ${orders.cancelled.length} cancelled` : ''}${orders.working.length ? `, ${orders.working.length} still working` : ''})` : '';
        const closeSummary = `day ${report.dayReturnPct ?? '—'}% vs SPY ${report.spyPct ?? '—'}% · ${report.trades} orders${ord} · ${snap.positions.length} positions`;
        record('close', { summary: closeSummary, equity: snap.equity });
        const closeNote = { title: `Shoal ${ny.date}: ${report.dayReturnPct != null ? `${report.dayReturnPct >= 0 ? '+' : ''}${report.dayReturnPct}%` : 'day report'}`,
          text: `Equity $${Math.round(snap.equity || 0).toLocaleString()} · ${closeSummary}`, priority: 'default', tags: ['bar_chart'] };
        note(closeNote);
        state.reports = [{ ...report, positions: report.positions.length, orders: undefined }, ...(state.reports || []).filter(r => r.date !== ny.date)].slice(0, ENGINE.keepReports);
        state.lastCloseDate = ny.date;
        // the go-live check (step 6): notify when it starts or stops passing
        const ready = goLiveCheck(state.reports, { recent: state.recent || [], env: cfg.env });
        const prevReady = state.readiness && state.readiness.status;
        state.readiness = { status: ready.status, summary: ready.summary, date: ny.date };
        closeNote.text += `\nGo-live check: ${ready.summary}`;
        if (ready.status !== prevReady && (ready.status === 'ready' || prevReady === 'ready')) {
          note({ title: ready.status === 'ready' ? 'Shoal: go-live check passed' : 'Shoal: go-live check no longer passes', priority: 'high', tags: ['rocket'],
            text: ready.summary + (ready.status === 'ready' ? `\nTo go live:\n${HOW_TO_GO_LIVE.map((x, i) => `${i + 1}. ${x}`).join('\n')}` : '') });
        }
        // score the agents' calls and move their weights (never fails the close)
        try {
          const l = learn ? await learn(session, cfg, store, { now }) : null;
          if (l) record('learn', { summary: l.ok ? scorecardSummary(l.scorecard) : `scorecard: ${l.error}` });
          if (l?.ok) day.scorecard = l.scorecard;
          if (l) closeNote.text += `\n${l.ok ? scorecardSummary(l.scorecard) : `scorecard: ${l.error}`}`;
        } catch (err) { record('learn', { summary: `scorecard failed: ${err.message}` }); }
      }
    }
  } catch (err) {
    record('error', { summary: err.message });
    base.ok = false; base.error = err.message;
    note({ title: 'Shoal: engine error', text: `${due.join(', ')}: ${err.message}`, priority: 'high', tags: ['warning'] }, `error-${err.message.slice(0, 40)}`);
  } finally {
    state.recent = [...events.map(e => ({ phase: e.phase, at: e.at, summary: e.summary })).reverse(), ...(state.recent || [])].slice(0, ENGINE.keepEvents);
    state.lastTick = now.toISOString();
    state.lockUntil = 0;
    await store.put(dayKey, day);
    await store.put('state.json', state);
  }
  let notified = 0;
  for (const m of notes) { try { if ((await send(m))?.sent) notified++; } catch { /* never fails a tick */ } }
  return { ...base, ran: events.map(e => e.phase), events: events.map(e => ({ phase: e.phase, summary: e.summary })), notified };
}

function summarise(r) {
  if (!r) return 'no result';
  if (r.skipped) return r.skipped;
  if (!r.ok) return `error: ${r.error}`;
  const parts = [];
  if (r.sells?.length) parts.push(`sold ${r.sells.join(', ')}`);
  if (r.buys?.length) parts.push(`bought ${r.buys.map(b => b.sym).join(', ')}`);
  if (r.waiting?.length) parts.push(`waiting for cash: ${r.waiting.join(', ')}`);
  const votes = r.tally ? ` · team: ${r.tally.BUY} buy, ${r.tally.SELL} sell, ${r.tally.HOLD} hold, ${r.tally.WAIT} wait` : '';
  return (parts.length ? parts.join('; ') : `holding ${r.picks?.length ?? 0} positions, nothing to change`) + votes;
}

// The server engine: one source of truth for trading, driven by an external scheduler that calls
// /api/engine/tick every ~15 minutes on weekdays. Each tick asks Alpaca's market clock what is due:
//
//   open    once a day, 15+ minutes after the open: review holdings and the watchlist, place the day's orders
//   hourly  once per clock hour while the market is open (from an hour after the open): account and risk
//           snapshot, daily-loss guard, and finishing any orders the open couldn't complete
//   close   once a day after the session ends (full or half day): end-of-day report
//
// Decisions come from a strategy function. Until the 9-agent ensemble lands (step 2) that is the existing
// Rank & tilt (trader.js), so behaviour is unchanged while the plumbing changes. Everything is recorded in
// the store: state.json (what ran, recent events and reports — one read for the dashboard) and
// days/YYYY-MM-DD.json (that day's full log). A tick with nothing due reads state and writes nothing.
import { runTilt } from './trader.js';

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
  return { equity: round2(num(acct.body?.equity)), cash: round2(num(acct.body?.cash)), positions };
}

export async function engineTick({ session, store, cfg, strategy = runTilt, now = new Date(), dry = false }) {
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
  try {
    for (const phase of due) {
      if (phase === 'open') {
        const snap = await snapshot(session);
        day.openEquity = snap.equity;
        const r = await strategy(session, cfg, { now });
        record('open', { summary: summarise(r), result: r, equity: snap.equity, positions: snap.positions.length });
        state.lastOpenDate = ny.date;
      }
      if (phase === 'hourly') {
        const snap = await snapshot(session);
        const start = day.openEquity ?? snap.equity;
        const dayRet = start > 0 ? snap.equity / start - 1 : 0;
        const lossHit = dayRet <= -(cfg.dailyLossPct ?? 5) / 100;
        // finish anything the open couldn't (e.g. buys waiting for sells to settle), unless the daily loss limit is hit
        const r = lossHit ? { ok: true, skipped: `daily loss limit (${(dayRet * 100).toFixed(1)}%)` } : await strategy(session, cfg, { now });
        record('hourly', { summary: lossHit ? r.skipped : summarise(r), result: r, equity: snap.equity, dayReturnPct: round2(dayRet * 100), positions: snap.positions.length });
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
        const report = { date: ny.date, equityOpen: start, equityClose: snap.equity, dayReturnPct: start > 0 ? round2((snap.equity / start - 1) * 100) : null, spyPct,
          positions: snap.positions, trades: day.events.reduce((n, e) => n + ((e.result && e.result.orders) || []).length, 0) };
        day.report = report;
        record('close', { summary: `day ${report.dayReturnPct ?? '—'}% vs SPY ${report.spyPct ?? '—'}% · ${report.trades} orders · ${snap.positions.length} positions`, equity: snap.equity });
        state.reports = [{ ...report, positions: report.positions.length }, ...(state.reports || []).filter(r => r.date !== ny.date)].slice(0, ENGINE.keepReports);
        state.lastCloseDate = ny.date;
      }
    }
  } catch (err) {
    record('error', { summary: err.message });
    base.ok = false; base.error = err.message;
  } finally {
    state.recent = [...events.map(e => ({ phase: e.phase, at: e.at, summary: e.summary })).reverse(), ...(state.recent || [])].slice(0, ENGINE.keepEvents);
    state.lastTick = now.toISOString();
    state.lockUntil = 0;
    await store.put(dayKey, day);
    await store.put('state.json', state);
  }
  return { ...base, ran: events.map(e => e.phase), events: events.map(e => ({ phase: e.phase, summary: e.summary })) };
}

function summarise(r) {
  if (!r) return 'no result';
  if (r.skipped) return r.skipped;
  if (!r.ok) return `error: ${r.error}`;
  const parts = [];
  if (r.sells?.length) parts.push(`sold ${r.sells.join(', ')}`);
  if (r.buys?.length) parts.push(`bought ${r.buys.map(b => b.sym).join(', ')}`);
  if (r.waiting?.length) parts.push(`waiting for cash: ${r.waiting.join(', ')}`);
  return parts.length ? parts.join('; ') : `holding ${r.picks?.length ?? 0} picks, nothing to change`;
}

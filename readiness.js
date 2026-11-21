// The go-live check (step 6), run after every end-of-day report and shown on Performance.
// The bar agreed for live money: over the last month of paper trading (21 trading days), Shoal beats the
// S&P 500 after costs on a risk-adjusted basis, and the engine ran reliably. Each check is listed with
// its numbers, so a failure says exactly what's missing. Passing never switches anything on: going live
// stays a deliberate change of the server's settings (live keys, ALPACA_ENV=live, SHOAL_SERVER_LIVE=1).
//
// Paper fills are real market prices, so the paper returns already include the spread; Alpaca charges
// no commission. A month is short: the excess-return t-statistic is shown so a pass by luck is visible.

export const READY = { days: 21, maxDdSlackPct: 2, maxMissedDays: 2, maxErrors: 1, maxRejectPct: 10 };

const sharpe = (r) => {
  const n = r.length, m = r.reduce((a, b) => a + b, 0) / (n || 1);
  const sd = Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, n - 1));
  return sd > 0 ? (m / sd) * Math.sqrt(252) : 0;
};
const growth = (r) => r.reduce((a, x) => a * (1 + x), 1) - 1;
const maxDD = (r) => { let v = 1, peak = 1, dd = 0; for (const x of r) { v *= 1 + x; peak = Math.max(peak, v); dd = Math.min(dd, v / peak - 1); } return dd; };
const weekdaysBetween = (a, b) => { let n = 0; for (let d = new Date(a + 'T12:00:00Z'); ; ) { d = new Date(d.getTime() + 864e5); const s = d.toISOString().slice(0, 10); if (s >= b) break; if (d.getUTCDay() % 6) n++; } return n; };
const r2 = (x) => Math.round(x * 100) / 100;

// reports: newest first (as state.reports); recent: engine events, newest first
export function goLiveCheck(reports = [], { recent = [], env = 'paper', o = {} } = {}) {
  const R = { ...READY, ...o };
  if (env === 'live') return { status: 'live', checks: [], summary: 'Trading live money.' };
  const ok = reports.filter(x => Number.isFinite(x.dayReturnPct) && Number.isFinite(x.spyPct));
  const win = ok.slice(0, R.days).reverse(); // oldest first
  const days = win.length;
  if (days < R.days) {
    return { status: 'collecting', days, needed: R.days, checks: [], summary: `Paper trading: ${days} of ${R.days} trading days so far. The check runs once a full month is in.` };
  }
  const from = win[0].date, to = win[days - 1].date;
  const s = win.map(x => x.dayReturnPct / 100), b = win.map(x => x.spyPct / 100);
  const ex = s.map((x, i) => x - b[i]), exM = ex.reduce((a, c) => a + c, 0) / days;
  const exSd = Math.sqrt(ex.reduce((a, c) => a + (c - exM) ** 2, 0) / (days - 1));
  const shoal = { returnPct: r2(growth(s) * 100), sharpe: r2(sharpe(s)), maxDDPct: r2(maxDD(s) * 100) };
  const spy = { returnPct: r2(growth(b) * 100), sharpe: r2(sharpe(b)), maxDDPct: r2(maxDD(b) * 100) };
  let missed = 0;
  for (let k = 1; k < days; k++) missed += weekdaysBetween(win[k - 1].date, win[k].date);
  const errors = recent.filter(e => e.phase === 'error' && String(e.at).slice(0, 10) >= from).length;
  const orders = win.reduce((a, x) => a + (x.fills || 0) + (x.rejected || 0), 0), rejected = win.reduce((a, x) => a + (x.rejected || 0), 0);
  const rejectPct = orders ? (rejected / orders) * 100 : 0;
  const checks = [
    { id: 'return', label: 'Return beats the S&P 500', pass: shoal.returnPct > spy.returnPct, detail: `${shoal.returnPct}% vs ${spy.returnPct}%` },
    { id: 'sharpe', label: 'Risk-adjusted return (Sharpe) beats the S&P 500', pass: shoal.sharpe > spy.sharpe, detail: `${shoal.sharpe} vs ${spy.sharpe}` },
    { id: 'drawdown', label: `Worst fall no more than ${R.maxDdSlackPct} points worse than the S&P 500's`, pass: shoal.maxDDPct >= spy.maxDDPct - R.maxDdSlackPct, detail: `${shoal.maxDDPct}% vs ${spy.maxDDPct}%` },
    { id: 'missed', label: 'The engine ran every trading day', pass: missed <= R.maxMissedDays, detail: missed ? `${missed} weekday${missed === 1 ? '' : 's'} without a report (holidays count here too)` : 'no gaps' },
    { id: 'errors', label: 'No repeated engine errors', pass: errors <= R.maxErrors, detail: `${errors} error${errors === 1 ? '' : 's'} in the window` },
    { id: 'orders', label: `Orders fill reliably (under ${R.maxRejectPct}% rejected)`, pass: rejectPct < R.maxRejectPct, detail: `${rejected} of ${orders} rejected` },
  ];
  const t = exSd > 0 ? (exM / exSd) * Math.sqrt(days) : 0;
  const pass = checks.every(c => c.pass);
  return {
    status: pass ? 'ready' : 'not ready', days, from, to, shoal, spy, checks, excessT: r2(t),
    summary: pass
      ? `Ready for live money: over ${days} trading days Shoal made ${shoal.returnPct}% vs ${spy.returnPct}% for the S&P 500 (Sharpe ${shoal.sharpe} vs ${spy.sharpe}).${Math.abs(t) < 2 ? ` One month is short (excess-return t ${r2(t)}, under 2): start small.` : ''}`
      : `Not ready: ${checks.filter(c => !c.pass).map(c => `${c.label.toLowerCase()} (${c.detail})`).join('; ')}.`,
  };
}

export const HOW_TO_GO_LIVE = [
  'Open a live Alpaca account and create live API keys.',
  'Vercel → Settings → Environment Variables (Sensitive): replace ALPACA_KEY_ID and ALPACA_SECRET with the live keys, set ALPACA_ENV=live and SHOAL_SERVER_LIVE=1.',
  'Start small: SHOAL_LIVE_CAPITAL caps the money the engine invests (e.g. 1000), whatever the account holds.',
  'Redeploy. The next open review trades live. To stop: delete ALPACA_SECRET (or set ALPACA_ENV=paper) and redeploy.',
];

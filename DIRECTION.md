# Change of direction (November 2026): a server-side multi-agent trading engine

Shoal started as a browser app in which a swarm of indicator "agents" voted on trades. Testing on real
data showed most of those agents had no predictive power, the default strategy (Rank & tilt) ignored
their votes, and nothing traded unless a browser tab was open. Shoal is being rebuilt around the purpose
it was meant to serve:

- **A small team of agents, each using a well-evidenced method**, scoring every watched stock, held or
  not, with a probability and a confidence.
- **An odd number of agents (9)**: 7 stock pickers, 1 market-timing agent and 1 risk agent. A majority
  of the pickers plus a confidence threshold and a cost check decide BUY or SELL; a tie or low confidence
  means HOLD.
- **Learning from every call**: each call is scored against the market, after costs, when its horizon
  is reached, whether or not it was traded. Weights update at the end of each day with damping; full
  refits are adopted only if they beat the current model on data they weren't fitted to. Training uses
  real history only (broker or CSV), never the fictional market.
- **A trading day run by the server, not the browser**, driven by the market clock: an open review
  (15 minutes after the open), hourly checks (risk, unfinished orders) and an end-of-day report and
  agent scorecard. Direction is decided daily; hourly checks are for risk, because price moves over an
  hour are mostly noise (the Intraday lab came out NO-GO).
- **Paper first.** Live money only after at least a month of paper results beating buy & hold on a
  risk-adjusted basis, after costs.

## The 9 agents

| # | Agent | Role | Method | Horizon |
|---|---|---|---|---|
| 1 | Momentum | picker | 12-month return excluding the last month, risk-adjusted | 1–3 months |
| 2 | 52-week high | picker | price relative to its 52-week high | 1–3 months |
| 3 | Sector strength | picker | sector trend over 3–6 months | 1–3 months |
| 4 | Short-term reversal | picker | last 5–20 days vs sector peers, faded | 1–4 weeks |
| 5 | Low volatility | picker | 60–250 day volatility and beta | months |
| 6 | Volume shock | picker | abnormal volume with price direction | ~1 month |
| 7 | News drift | picker | large gap on heavy volume, then follow-through | 1–3 months |
| 8 | Market trend | timing | index vs 200-day average, 12-month trend, breadth | weeks–months |
| 9 | Risk guardian | risk | volatility jumps, crash days, drawdowns: sizing and exits | days/hours |

The 16 original agents are retired (not kept as advisory).

## Steps

1. **Server engine, durable storage and a free external scheduler** (this step).
2. The 9 agents, each tested in the Swing lab, plus the majority-and-confidence rule.
3. The daily cycle's learning: scoring every call, end-of-day scorecard and damped weight updates.
4. Hourly risk guardian and order handling.
5. Simpler screens (Today / Agents / Performance / Lab / Settings) and notifications.
6. A month of paper trading, then a decision on live money.

## Step 1: what's in place

- `engine.js`: the engine. Each tick reads Alpaca's market clock and runs what is due: `open` once a day
  15+ minutes after the open, `hourly` once per clock hour from an hour after the open (snapshot, daily
  loss guard, finishing orders), `close` once after the session ends, full or half day (end-of-day
  report against SPY). Ticks are idempotent and locked; a tick with nothing due writes nothing.
  Decisions come from Rank & tilt until step 2 replaces it with the 9 agents.
- `store.js`: durable JSON storage. Vercel Blob (private store `shoal-engine`) in production, files
  locally. `state.json` holds what ran, recent events and daily reports; `days/YYYY-MM-DD.json` holds
  each day's full log.
- `.github/workflows/engine.yml`: the free scheduler. GitHub Actions calls `POST /api/engine/tick` every
  15 minutes, 13:00–21:59 UTC on weekdays, which covers both the UK/US clock-change weeks. It needs the
  repository secrets `SHOAL_ENGINE_URL` and `SHOAL_ENGINE_SECRET` (= `CRON_SECRET`). GitHub runs
  scheduled workflows only from the default branch.
- API: `/api/engine/tick` (scheduler secret), `/api/engine/status` and `/api/engine/day?date=` (behind
  the login). The old once-a-day Vercel cron is removed so nothing trades twice.
- Settings → **Server engine** shows status, storage, the last runs and the daily reports.

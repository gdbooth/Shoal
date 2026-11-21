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

1. **Server engine, durable storage and a free external scheduler** (done).
2. **The 9 agents, each tested in the Swing lab, plus the majority-and-confidence rule** (done).
3. **The daily cycle's learning: scoring every call, end-of-day scorecard and damped weight updates** (done).
4. Hourly risk guardian and order handling.
5. Simpler screens (Today / Agents / Performance / Lab / Settings) and notifications.
6. A month of paper trading, then a decision on live money.

## Step 1: what's in place

- `engine.js`: the engine. Each tick reads Alpaca's market clock and runs what is due: `open` once a day
  15+ minutes after the open, `hourly` once per clock hour from an hour after the open (snapshot, daily
  loss guard, finishing orders), `close` once after the session ends, full or half day (end-of-day
  report against SPY). Ticks are idempotent and locked; a tick with nothing due writes nothing.
  Decisions come from the 9-agent team (step 2); SHOAL_STRATEGY=tilt switches back to Rank & tilt.
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

## Step 2: what's in place

- `signals.js`: the 9 agents replace the 16 old ones. The 7 pickers rank the watchlist every day and
  vote BUY for the top 30% and SELL for the bottom 30% on their own measure (strength 0.3–1.0 by rank);
  Market trend votes on the whole market; Risk guardian votes SELL with a strength when it sees danger.
- `teamDecision`, the majority rule: BUY when at least 4 of the 7 pickers back a stock, their combined
  confidence (weighted score) is at least 0.25, the risk guardian's danger is below 1.0 and the market
  trend is not strongly down; SELL a holding when 4 of 7 turn against it or danger reaches 1.0; otherwise
  HOLD (held) or WAIT. Seven pickers means no ties.
- `runTeam`: the same rule backtested day by day (decide at the close, trade at the next open, costs on
  every trade, half-size buys while the market trend is down). The Swing lab tests every agent on its own.
- `trader.js` `runTeamLive`: the engine now trades the team on paper by default. It decides on completed
  daily bars only, so the open review and the hourly checks see the same votes all day, and records
  every decision (each agent's vote, score, confidence) for step 3 to score. `SHOAL_STRATEGY=tilt`
  switches the engine back to Rank & tilt.
- App: the agent screens, guide and Server engine card describe the 9 agents; the engine card's
  preview shows the team's votes.

### Honest results on real data (5 bp per side)

| Data | Team rule | Rank & tilt | Buy & hold |
|---|---|---|---|
| 12 stocks + ETFs, Nov 2017 – Nov 2026 | +62%, Sharpe 0.53 | +873%, 1.01 | +1002%, 0.98 |
| 24 stocks, 2014–2018 | +67%, Sharpe 1.25 | +174%, 1.55 | +106%, 1.34 |

The team makes money but trails buy & hold, mainly because it holds far fewer stocks for less of the
time. Momentum is the strongest picker; the Risk guardian predicts turbulence very reliably (t 6–11) but
as a seller it whipsaws, so its exit threshold was raised to 1.0 (strong danger only). Changing the
majority (3 or 5 of 7) or adding a fill-up rule didn't close the gap.

**Direction note:** the team is implemented as specified and trades on paper, because the purpose of
the tool is a voting team that learns. Step 3 (scoring every call, damped weight updates) is where it
can improve; the live-money gate stays shut until a month of paper results beats buy & hold.

## Step 3: what's in place

- **Every call is scored.** Each agent's vote on each watched stock, traded or not, is scored 5 and 21
  trading days later against how that stock did relative to the watchlist average (rank correlation, IC).
  Market Trend is scored on the market's direction, the Risk Guardian on whether danger came before
  turbulence, and the team on its BUY calls after a round-trip cost. Votes are recomputed from the
  broker's price history, so the first scorecard already holds a year of real calls.
- **End-of-day scorecard.** After each close the engine fetches ~560 trading days of bars, scores every
  call whose horizon has passed (`S.learnUpdate`, stored in `learning.json`) and records a `learn` event.
  Settings → Server engine shows the scorecard; **Build scorecard now** builds it without waiting for a
  close (it only reads prices).
- **Damped weight updates.** Each picker's weight moves 10% a day towards 1 + (|t| − 1)/2 in the
  direction of its t-statistic (clamped 0.25–2.5, average kept at 1). A record with |t| ≤ 1 counts as
  noise. The weights scale each picker's say in the team's confidence; the 4-of-7 vote is unchanged.
  The open review and hourly checks use the latest weights.
- **Retiring agents.** A picker with t ≤ −2 over 60+ scored days is flagged as a retire candidate in the
  scorecard and the end-of-day event. Retiring it is the owner's decision.
- Fix: the live team now fetches 600 calendar days of bars (~410 trading days); 420 left Momentum
  (273 days of lookback) with barely enough history.

### Honest results (walk-forward on real data, 5 bp per side)

The team used, each day, only weights learned from calls whose horizon had already passed.

| Data | Team, equal weights | Learned, no gate | Learned, gated (shipped) |
|---|---|---|---|
| 24 stocks, 2014–2018 | +67%, Sharpe 1.25 | +59%, 1.12 | +63%, 1.19 |
| 12 stocks + ETFs, 2017–2026 | +62%, 0.53 | +38%, 0.36 | +67%, 0.54 |

Without the gate the weights chased noise and cost return; with it, learning does no harm and moves a
weight only on evidence. No picker reached t ≥ 2 on either history; the Risk Guardian again spotted
turbulence (t 6.3–6.4). The most useful finding: the team's **BUY calls trailed the average watched stock**
after costs (21-day: −0.7% with 44% beating it on 2014–2018; −1.4% with 32% on 2017–2026). The
majority rule picks stocks the pickers agree on, and that agreement hasn't paid. The live scorecard will
show whether this holds on current data; step 4 and the paper month should be judged against it.

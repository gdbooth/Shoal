# Shoal
Trading App
Shoal is a trading app that allows users to buy and sell stocks, cryptocurrencies, and other financial instruments. 
It provides real-time market data, advanced charting tools, and a user-friendly interface for managing your portfolio.

## Using the app

Start with **Guide · start here** at the top of the app's menu: the recommended workflow (keep Rank & tilt
and the Balanced risk level, check it against buy & hold in SIMULATED, paper trade in VIRTUAL, judge it over
months), what the testing has shown so far, every mode, style, screen and setting, how to read the labs
(GO / BORDERLINE / NO-GO, IC, t, bp, Sharpe), and the limits. The menu is split into **Workspace** (everyday
screens) and **Test & tune** (backtest, optimiser, labs, agent detail).

**Stocks watched**: 100 large US stocks across 11 sectors by default (`STOCK_CATALOG` in `index.html`;
the original 25 come first). Settings → Stocks watched edits the list (5–150 symbols, saved in the browser
as `shoal_watchlist_v1`, applied on reload); "Default 100" and "Original 25" reset it. IG gets only the first
30 (its weekly history allowance), the Intraday lab the first 40. History already cached in the browser is
topped up; symbols new to the list get their full history.

## Security and server trading

- **Login**: when `SHOAL_LOGIN_PASSWORD` is set (username `SHOAL_LOGIN_USER`, default `admin`), the server
  serves the app itself (index.html and its scripts, no longer static files on Vercel) only after logging in
  at `/login`; every `/api` route except health, login and the cron job needs the login too. The cookie is
  signed, HttpOnly, SameSite=Strict, Secure on HTTPS, lasts 7 days; changing the password logs everyone out.
- **Access code**: when `SHOAL_ACCESS_CODE` is set (and you aren't logged in), `/api/connect` requires it (header `x-shoal-access`;
  the app asks for it and remembers it in the browser).
- **Sessions**: the broker secret travels only inside an AES-256-GCM token sealed with
  `SHOAL_SESSION_SECRET`; tokens last 8 hours and are accepted only in the `Authorization` header. The live
  stream uses a one-minute ticket from `POST /api/stream-ticket`, so the token never appears in a URL.
- **Browser calls**: on Vercel only the app's own origin (plus `SHOAL_ALLOWED_ORIGINS`) may call the API;
  per-IP rate limits (600/min, 10/min for connect); security headers on the API and the static app.
- **Server trading** (`trader.js`, `vercel.json` cron `0 18 * * 1-5` UTC → `/api/cron/tilt`): once a day
  while the market is open it runs Rank & tilt on the Alpaca account in `ALPACA_KEY_ID` / `ALPACA_SECRET`
  (`ALPACA_ENV=paper`; live also needs `SHOAL_SERVER_LIVE=1`): picks = top `SHOAL_TOPK` (12) of
  `SHOAL_WATCHLIST` (default 100) by trend score as of last month's close; sells non-picks; buys missing
  picks with equity × `SHOAL_INVEST_FRACTION` (0.9) / K, from cash on hand. Requires `CRON_SECRET` (Vercel
  sends it). `GET /api/cron/tilt?dry=1` (with the secret) or Settings → Server trading → Preview shows the
  plan without trading. When it trades the account the browser is connected to, the browser places no orders.

## Running

```
npm install
npm start        # backend on http://localhost:3001
npm test         # adapter tests against mock Alpaca and IG servers
```

Open `index.html` and connect a broker under **Settings → Connect broker**. Credentials go to the
backend and are held in memory only.

## Brokers

| Broker | Account | Paper / demo | Live |
|---|---|---|---|
| Alpaca | US equities | `paper-api.alpaca.markets` | `api.alpaca.markets` |
| IG | Spread betting (daily funded bets) | `demo-api.ig.com` | `api.ig.com` |

Each broker is an adapter in `brokers/`. Adapters translate their API into the Alpaca-shaped JSON the
frontend already understands, so adding a broker doesn't touch the trading logic.

### IG notes

- **Login:** API key + username + password. The backend logs in (`POST /session` v2), then switches to
  the spread betting account (`PUT /session`). Enter an account ID to pick one explicitly.
- **Tickers → epics:** each ticker is searched once (`GET /markets?searchTerm=`), matched to its
  `DFB` shares epic and cached in `.cache/ig-epics-<env>.json`. To pin or block a ticker, create
  `ig-epics.json` in the project root, e.g. `{ "AAPL": "UA.D.AAPL.DAILY.IP", "COP": null }`.
- **Orders:** the frontend's dollar notional becomes a stake: `£/point = notional ÷ price`, rounded
  down to 2 dp. Orders below IG's minimum stake are refused before dealing. Every deal is
  checked with `GET /confirms/{dealReference}`.
- **Prices:** streamed over Lightstreamer from the endpoint returned at login. If streaming is down,
  the backend falls back to one REST snapshot a minute.
- **Rate limits:** requests are throttled to 25/min (non-trading) and 50/min (trading); override with
  `IG_NON_TRADING_PER_MIN` / `IG_TRADING_PER_MIN`. Account and positions are cached for 15 s.
  Daily bars are cached on disk and topped up incrementally to save the weekly historical-data
  allowance, so the first load takes about 2 minutes and later loads are instant.

## Agents

`signals.js` holds the signal engine: indicators, regime detection, the 16 agents, the ensemble and a
walk-forward backtester. It's a plain script loaded by `index.html` and unit-tested in Node
(`test/signals.test.mjs`, including a check that no agent looks at future bars).

Agents work on daily OHLCV bars, price and volume only:

| Agent | Model |
|---|---|
| Trend Follower | MACD histogram + EMA order, only when ADX ≥ 20 |
| Bollinger Reverter | close outside a Bollinger band (or near it with RSI), only when ADX ≤ 25 |
| Squeeze Breakout | Bollinger bands inside Keltner channels, then a band break on volume |
| VWAP Reversion | fade 20-day VWAP stretches in ranges; buy pullbacks to VWAP in trends |
| Volatility Regime | ATR expanding below the 50-day average = risk-off; contracting above it = risk-on |
| Return Skew | lottery-like positive skew sells, crash-risk negative skew buys |
| Money Flow | Chaikin money flow, confirmed by on-balance volume |
| Range Contraction | NR7 / inside day at low ATR, direction from close location and EMA slope |
| Relative Strength | 20-day return vs sector peers; catch-up after a sector move |
| Pairs Spread | log-price spread z-score vs the most-correlated sector peer |
| Market Breadth | share of the universe above its 50/200-day averages + index trend |
| Trend Persistence | 6-month return skipping the last month, volatility-scaled |
| Risk-Adjusted Return | 60-day Sortino ratio |
| Gap Reactor | opening gaps: holding on volume = continuation, filling = reversal |
| Attention | abnormal volume on a decisive day → follow-through |
| Pattern Memory | 10 nearest past indicator setups + candlestick patterns |

Without volume data (IG spread bets) the volume agents fall back to price-only versions.

Each stock's market is classified as trend or range (ADX) and calm or volatile (ATR% rank).

## Strategy

Settings has four main controls; everything else is under *Advanced*.

- **Risk level**: Cautious / Balanced / Bold. Sets equity invested, risk per trade, position limits,
  stop widths, the confidence needed to act and the daily loss limit.
- **Style**:
  - *Rank & tilt* (default): fully invested in the top 12 stocks by trend score (return from 6 months to
    1 month ago), re-ranked at each month end; dropped names are sold, new ones bought, survivors left
    alone. Not a reliable way to beat holding everything. Real daily data after 5bp costs:
    - 12 stocks + sector funds, 2017–2026: +1153% vs +1178% for buy-and-hold, worst drop −39% vs −49%
      (ahead in 5 of 8 years; most of the lead came in 2020, and it lost less in 2022).
    - 6 sector funds alone (XLB XLE XLF XLK XLP XLV), 2017–2026: +119% vs +176%.
    - 23 stocks, 2013–2018: 223% vs 139%, mostly from staying in NVDA and AMD (without them: 85% vs 74%).
    An optional crash guard (cash when the market is below its 200-day average) exists in the engine
    but is not used by the app: it cut drops in 2020, 2022 and 2025 but missed the rebounds and lost
    badly over the full period.
  - *Stay invested*: hold every stock at an equal share of equity, sell one when it shows
    weakness, buy it back when that clears. The default weakness signal is Trend Persistence: on
    2015–2018 daily data it kept 88% of buy-and-hold's 95% gain with a −10% worst drop (vs −15%).
  - *Trade both ways*: long and short trades with ATR stops and targets. It lost to buy-and-hold on
    the same data.
- **Autopilot** (off by default) is the combination model: agents emit scores (direction × strength); a
  ridge regression turns the trend score plus the scores of agents with positive evidence into an
  expected next-month return per stock, shrunk toward trusting only the trend score. It refits every
  quarter on past data; a new version is adopted only if it ranked stocks better on the 60 days it wasn't
  fitted on. Rank & tilt ranks by it; the other styles take agent weights from it. Changes are logged.
  On 2015–2018 data it made 153% vs 175% for the plain trend score, which is why it's off.
- **Costs**: every buy and sell pays a per-side cost (Alpaca 5bp, IG spread bets 12bp, fictional 5bp;
  adjustable under Advanced) in replays, backtests and the optimiser.
- **Intraday lab** (Phase 1 of day trading, go / no-go): with Alpaca connected, loads 20–60 trading
  days of 5-minute bars (IEX feed) for the stocks plus SPY, keeps the regular session, and has 11
  price/volume agents (`intraday.js`: opening range, VWAP stretch, 30-minute momentum, 5-minute RSI,
  volume surge, buying vs selling pressure, gap, market direction, relative strength, time of day,
  multi-day trend) score every stock at every bar close using only what was known then. The first 60% of
  days fit a combined model (ridge for the expected move, logistic for the probability of a rise); the
  last 40% test it: each agent's predictive power and edge after costs, calibration of the confidence,
  agent overlap, and a flat-overnight trading test (enter next bar's open, exit after 15/30/60 minutes).
  GO needs a per-trade profit after costs on unseen days with daily t ≥ 2 and at least one agent that
  predicts reliably on its own. Places no orders. A fictional random market is included as a demo (it
  should come out NO-GO).
  The lab also runs a fixed, published test on SPY: the first half hour (yesterday's close → 10:00)
  predicting the last half hour (15:30 → 16:00), trading at 15:30 and out at the close.
- **Swing lab** (`swing.js`): the 16 daily agents together over 2–10 day holds. Every day each agent
  scores every stock (−1…1); a combined model (ridge for the expected move, logistic for the probability
  of a rise) is refitted every quarter on past outcomes only and used on the following days. Shows the
  verdict, decision cards for the latest close (probability, expected move, which agents pushed for and
  against), a trading test against buy & hold and the trend score alone, each agent's say, calibration,
  and each agent on its own. Runs on broker daily history, an imported CSV or the fictional market. On
  real data so far (12 stocks and sector funds 2016–2026; 24 stocks 2013–2018; 2-, 5- and 10-day holds)
  it was NO-GO every time: no reliable stock picking on unseen years and a lower Sharpe than buy & hold.
  **Ranked readings** (default; step 1 of the agent redesign): besides its vote, every agent now reports a
  continuous reading every day (`agentReadings` in `signals.js`: the quantity it judges, before any
  threshold), ranked across the stocks to −1…+1. Agents have roles: 14 stock pickers (judged on the move
  relative to the other stocks), Market Breadth for market timing and Volatility Regime for risk (calm vs
  turbulent ahead), each reported on its own test. The combined model uses the pickers only, fitted to the
  relative return; the trading test then always holds the best-ranked stocks (at most half), re-ranked
  every H days, so it measures stock picking against holding them all. Horizons 2, 5, 10 and 21 days. An
  individual agent counts only with t ≥ 3 on unseen days (2–3 is "promising"). Result on real data so
  far: still NO-GO (no agent reached even "promising"; the trend score alone was the closest to buy & hold).
- **Agent evidence**: Agent config shows each agent's next-month rank IC on the data in use. Agents without
  positive evidence (t ≥ 1) are advisory and don't vote; the model prunes the same way, walk-forward.
- **Daily loss limit**: once equity is down this much in a day, no new positions until the next day.

Regime-aware weights and the correlation penalty are under Advanced, off by default: on 2014–2018 daily
data they lowered returns in every test period.

## Modes

- **SIMULATED** replays daily history one day per tick, with local fills and no orders. *Replay data*
  in Settings picks the source: *Auto* (the broker's history when connected — 3, 5 or 10 years from
  Alpaca as its data plan allows, 220 days from IG — otherwise the fictional market), *Fictional*,
  *Broker*, or *Imported*: one or more CSVs you choose (`date,symbol,open,high,low,close,volume`; pick several to combine them), read in the
  browser, kept in IndexedDB and never uploaded. Use it for longer validation history from any source
  you're licensed to use.
  The fictional market is generated in the browser (no network): two years of made-up daily prices
  ending today, plus about 21 months of warm-up history before them. It shows how a strategy behaves, not whether it
  works on real prices, and it never reaches VIRTUAL or LIVE.
- **VIRTUAL** sends orders to the broker's paper/demo account.
- **LIVE** sends real orders.

The dashboard compares Shoal with buying and holding the same stocks over the same period.

## Optimiser

The **Optimiser** screen fits settings to recent history and then checks whether that helped:

1. **Optimise** the last N days (default 100; ends at the day being replayed in SIMULATED, or the latest
   broker bar otherwise). It searches style, which agents decide, confidence threshold, share invested,
   ATR stop/target, holding period and the deciding agent's main setting, for the highest return.
   A **held-out check** runs the result on the N days *before* the window, which the search never saw.
   The goal is after-cost return with a penalty for drops beyond the risk level's cap, each style searches
   only its own settings, and **Apply is locked unless the held-out check passes**.
2. **Apply & freeze**: the optimised settings are applied and Settings / Agent config are locked. Your
   previous settings are kept.
3. **Run again & compare**: frozen vs previous settings vs buy-and-hold on the days since freezing, with a
   better / worse verdict and how much of the optimised advantage carried over.

On real 2015–2018 prices, across 11 rolling 100-day windows, optimised settings averaged +12.1% inside
their window vs +5.4% for the defaults, but +7.8% vs +7.2% over the following 100 days. The held-out check
called the next-period winner in 8 of 11 windows.

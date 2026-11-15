# Shoal
Trading App
Shoal is a trading app that allows users to buy and sell stocks, cryptocurrencies, and other financial instruments. 
It provides real-time market data, advanced charting tools, and a user-friendly interface for managing your portfolio.

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
    alone. On 2013–2018 daily data after costs: 223% vs 139% for holding all 23 stocks, ahead in 4 of 5
    years — but most of the gap came from staying in NVDA and AMD through 2016–17 (without them: 85% vs
    74%). It pays when strong trends exist.
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
- **Agent evidence**: Agent config shows each agent's next-month rank IC on the data in use. Agents without
  positive evidence (t ≥ 1) are advisory and don't vote; the model prunes the same way, walk-forward.
- **Daily loss limit**: once equity is down this much in a day, no new positions until the next day.

Regime-aware weights and the correlation penalty are under Advanced, off by default: on 2014–2018 daily
data they lowered returns in every test period.

## Modes

- **SIMULATED** replays daily history one day per tick, with local fills and no orders. *Replay data*
  in Settings picks the source: *Auto* (the broker's history when connected — 3, 5 or 10 years from
  Alpaca as its data plan allows, 220 days from IG — otherwise the fictional market), *Fictional*,
  *Broker*, or *Imported*: a CSV you choose (`date,symbol,open,high,low,close,volume`), read in the
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

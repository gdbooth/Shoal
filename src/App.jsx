// src/App.jsx

// Top-level App + sidebar nav + mode chrome
export default const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/ {
        density: "Compact",
    accent: "Green",
    reasoning: true,
    animated: true,
    glyph: "◐",
      }; /*EDITMODE-END*/

    // ── Per-trade P&L bars (used in ScreenPnlTrend) ─────────────────────────────
    const PnlBars = ({trades, height = 110}) => {
        if (!trades.length) return null;
        const maxAbs = Math.max(...trades.map((t) => Math.abs(t.pnl || 0)), 1);
    const W = 700,
    H = height,
    pad = {l: 50, r: 12 },
    mid = H / 2;
    const innerW = W - pad.l - pad.r;
    const barW = Math.max(2, Math.floor(innerW / trades.length) - 1);
    return (
    <svg
        viewBox={`0 0 ${W} ${H}`}
        className="chart"
        preserveAspectRatio="none"
        style={{ height }}
    >
        <line
            x1={pad.l}
            x2={W - pad.r}
            y1={mid}
            y2={mid}
            stroke="var(--line-2)"
            strokeWidth="0.5"
        />
        {trades.map((t, i) => {
            const x = pad.l + i * (innerW / trades.length);
            const h = Math.max(1, (Math.abs(t.pnl) / maxAbs) * (mid - 6));
            return (
                <rect
                    key={t.id}
                    x={x}
                    y={t.pnl > 0 ? mid - h : mid}
                    width={Math.max(1, barW)}
                    height={h}
                    fill={t.pnl > 0 ? "var(--up)" : "var(--down)"}
                    opacity="0.85"
                />
            );
        })}
    </svg>
    );
      };

    // ── ScreenAgentPerf ──────────────────────────────────────────────────────────
    const ScreenAgentPerf = ({mode, ctx}) => {
        const agentAccuracySeries = ctx?.agentAccuracySeries || { };
    const agentHistory = ctx?.agentHistory || { };
    const agentWeights = ctx?.agentWeights || { };

    const maxLen = AGENTS.reduce(
          (m, a) => Math.max(m, (agentAccuracySeries[a.id] || []).length),
    0,
    );

    const [sortKey, setSortKey] = React.useState("acc");
    const [sortDir, setSortDir] = React.useState(-1); // -1 = desc, 1 = asc

        const toggleSort = (key) => {
          if (sortKey === key) setSortDir((d) => d * -1);
    else {
        setSortKey(key);
    setSortDir(-1);
          }
        };

    const SortTh = ({col, label, align = "right"}) => (
    <th
        className="sortable"
        style={{ textAlign: align }}
        onClick={() => toggleSort(col)}
    >
        {label}
        <span className={"sort-arrow" + (sortKey === col ? " active" : "")}>
            {sortKey === col ? (sortDir === -1 ? " ↓" : " ↑") : " ↕"}
        </span>
    </th>
    );

        // An agent is excluded only if the user has manually disabled it via the toggle
        const isExcluded = (a) => (ctx?.dynamicExcluded || new Set()).has(a.id);

        // Build series: append null for excluded agents at the current end to show a gap
        const agentSeries = AGENTS.map((a) => {
          const s = agentAccuracySeries[a.id] || [a.accuracy];
    return isExcluded(a) ? [...s, null] : s;
        });

        const sortedAgents = React.useMemo(() => {
          return AGENTS.map((a) => {
            const hist = agentHistory[a.id] || [];
    const acc =
              hist.length >= 3
    ? hist.filter(Boolean).length / hist.length
    : null;
    const w = agentWeights[a.id] ?? a.weight;
    const excl = isExcluded(a);
    return {...a, hist, acc, w, excl};
          }).sort((a, b) => {
            // String sorts honour sortDir consistently with numeric sorts:
            // sortDir = -1 is "desc" (so for strings, that's reverse-alphabetical).
            if (sortKey === "name")
    return -sortDir * a.name.localeCompare(b.name);
    if (sortKey === "family")
    return -sortDir * a.family.localeCompare(b.family);
    if (sortKey === "status") {
              // ACTIVE (excl=false) ranks above DISABLED (excl=true) when descending.
              const sa = a.excl ? 1 : 0,
    sb = b.excl ? 1 : 0;
    return sortDir * (sb - sa);
            }
    let va, vb;
    if (sortKey === "acc") {
        va = a.acc ?? a.accuracy;
    vb = b.acc ?? b.accuracy;
            } else if (sortKey === "w") {
        va = a.w;
    vb = b.w;
            } else if (sortKey === "calls") {
        va = a.hist.length;
    vb = b.hist.length;
            } else {
        va = a.acc ?? a.accuracy;
    vb = b.acc ?? b.accuracy;
            }
    return sortDir * ((vb ?? 0) - (va ?? 0));
          });
        }, [agentHistory, agentWeights, sortKey, sortDir]);

    return (
    <div className="page" data-screen-label="08 Agent Performance">
        <div className="page-head">
            <div className="page-eyebrow">
                Agent intelligence · win/loss accuracy over time
            </div>
            <h1 className="page-title">
                Which agents are <em>earning their weight</em>?
            </h1>
            <p className="page-sub">
                Rolling accuracy is computed from each agent's last 30 closed
                calls. Weights shift via reinforcement after every close —
                strong agents grow, weak agents shrink. All enabled agents
                always contribute to every consensus call; use the Agent Config
                screen to manually disable any agent.
            </p>
        </div>

        <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-head">
                <div className="card-title">Rolling accuracy · all agents</div>
                <div className="card-meta">
                    {maxLen} data point{maxLen !== 1 ? "s" : ""} · rolling
                    30-trade window per agent
                </div>
            </div>
            {maxLen < 3 ? (
                <div
                    style={{
                        padding: "40px 0",
                        textAlign: "center",
                        color: "var(--ink-3)",
                        fontFamily: "var(--mono)",
                        fontSize: 12,
                    }}
                >
                    Collecting… {maxLen} closed trade{maxLen !== 1 ? "s" : ""}{" "}
                    with votes recorded — need at least 3
                </div>
            ) : (
                <>
                    <LineChart
                        series={agentSeries}
                        colors={AGENTS.map((a) =>
                            isExcluded(a) ? "var(--ink-3)" : a.color,
                        )}
                        labels={AGENTS.map((a) => a.name.split(" ")[0])}
                        endLabels={AGENTS.map((a) => {
                            const hist = agentHistory[a.id] || [];
                            const acc =
                                hist.length >= 2
                                    ? hist.filter(Boolean).length / hist.length
                                    : a.accuracy;
                            return (
                                a.name.split(" ")[0] +
                                " " +
                                (acc * 100).toFixed(0) +
                                "%"
                            );
                        })}
                        height={280}
                        yFmt={(v) => (v * 100).toFixed(0) + "%"}
                        fillFirst={false}
                        solidLines={true}
                        hLines={[
                            { value: 0.5, color: "var(--ink-4)", label: "50%" },
                        ]}
                    />
                    <div
                        className="legend"
                        style={{
                            marginTop: 10,
                            display: "flex",
                            flexWrap: "wrap",
                            gap: "4px 14px",
                        }}
                    >
                        {AGENTS.map((a) => {
                            const hist = agentHistory[a.id] || [];
                            const acc =
                                hist.length >= 2
                                    ? hist.filter(Boolean).length / hist.length
                                    : a.accuracy;
                            const excl = isExcluded(a);
                            return (
                                <span
                                    key={a.id}
                                    style={{
                                        display: "flex",
                                        alignItems: "center",
                                        gap: 4,
                                        fontSize: 11,
                                        opacity: excl ? 0.45 : 1,
                                    }}
                                >
                                    <span
                                        style={{
                                            width: 12,
                                            height: 2,
                                            background: excl ? "var(--ink-3)" : a.color,
                                            display: "inline-block",
                                            borderRadius: 1,
                                        }}
                                    ></span>
                                    <span
                                        style={{
                                            color: excl
                                                ? "var(--ink-3)"
                                                : acc >= 0.6
                                                    ? "var(--up)"
                                                    : acc < 0.5
                                                        ? "var(--down)"
                                                        : "var(--ink-2)",
                                            textDecoration: excl ? "line-through" : "none",
                                        }}
                                    >
                                        {a.name.split(" ")[0]}
                                    </span>
                                    {excl && (
                                        <span
                                            style={{
                                                color: "var(--down)",
                                                fontSize: 9,
                                                letterSpacing: "0.05em",
                                            }}
                                        >
                                            EXCL
                                        </span>
                                    )}
                                </span>
                            );
                        })}
                    </div>
                </>
            )}
        </div>

        <div className="card">
            <div className="card-head">
                <div className="card-title">Current standing</div>
                <div className="card-meta">click column headers to sort</div>
            </div>
            <table className="tbl">
                <thead>
                    <tr>
                        <SortTh col="name" label="Agent" align="left" />
                        <SortTh col="family" label="Family" align="left" />
                        <SortTh col="calls" label="Calls" />
                        <SortTh col="acc" label="Accuracy" />
                        <SortTh col="w" label="Weight" />
                        <SortTh col="status" label="Status" />
                    </tr>
                </thead>
                <tbody>
                    {sortedAgents.map((a) => (
                        <tr key={a.id} style={{ opacity: a.excl ? 0.5 : 1 }}>
                            <td>
                                <span
                                    style={{
                                        color: a.excl ? "var(--ink-3)" : a.color,
                                        marginRight: 8,
                                    }}
                                >
                                    {a.glyph}
                                </span>
                                {a.name}
                            </td>
                            <td className="mono tiny muted">{a.family}</td>
                            <td className="mono" style={{ textAlign: "right" }}>
                                {a.hist.length}
                            </td>
                            <td style={{ textAlign: "right" }}>
                                {a.acc !== null ? (
                                    <span
                                        className={
                                            a.acc >= 0.6 ? "up" : a.acc < 0.5 ? "dn" : ""
                                        }
                                    >
                                        {(a.acc * 100).toFixed(1)}%
                                    </span>
                                ) : (
                                    <span className="muted">–</span>
                                )}
                            </td>
                            <td className="mono" style={{ textAlign: "right" }}>
                                {(a.w * 100).toFixed(1)}%
                            </td>
                            <td style={{ textAlign: "right" }}>
                                {a.excl ? (
                                    <span
                                        className="dn"
                                        style={{ fontSize: 10, letterSpacing: "0.06em" }}
                                        title="Manually disabled via Agent Config — toggle on to re-enable"
                                    >
                                        DISABLED
                                    </span>
                                ) : (
                                    <span
                                        className="up"
                                        style={{ fontSize: 10, letterSpacing: "0.06em" }}
                                    >
                                        ACTIVE
                                    </span>
                                )}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    </div>
    );
      };

    // ── ScreenPnlTrend ───────────────────────────────────────────────────────────
    const ScreenPnlTrend = ({mode, ctx}) => {
        const {trades, tradesResetAt} = ctx || { };
    const resetAt = tradesResetAt || 0;
    const startEquity = ctx?.startingBalance ?? EQUITY.bot[0];
    const currentEquity = ctx?.balance ?? startEquity;
    const equityDelta = currentEquity - startEquity;
        const equityPct = startEquity > 0 ? equityDelta / startEquity : 0;

        const EquityHeader = () => {
          const lp = ctx?.livePrices;
    const ts = trades || [];
    const realized = ts
            .filter((t) => t.pnl != null && t.ts >= resetAt)
            .reduce((s, t) => s + t.pnl, 0);
    const unrealized = ts
            .filter((t) => t.status === "OPEN")
            .reduce((s, t) => s + unrealizedPnl(t, lp), 0);

    const Card = ({label, value, valueClass = "", sub}) => (
    <div className="card" style={{ padding: "12px 14px" }}>
        <div
            className="mono tiny muted"
            style={{ letterSpacing: "0.1em", marginBottom: 6 }}
        >
            {label}
        </div>
        <div className={"mono " + valueClass} style={{ fontSize: 17 }}>
            {value}
        </div>
        <div
            className="mono tiny muted"
            style={{
                marginTop: 6,
                lineHeight: 1.4,
                fontSize: 10,
                letterSpacing: "0.02em",
            }}
        >
            {sub}
        </div>
    </div>
    );

          const signed = (n) => (n >= 0 ? "+" : "") + fmtMoney(n, 0);

    return (
    <div
        style={{
            display: "grid",
            gridTemplateColumns: "repeat(5,1fr)",
            gap: 10,
            marginBottom: 16,
        }}
    >
        <Card
            label="STARTING EQUITY"
            value={fmtMoney(startEquity, 0)}
            sub="Account value at last reset"
        />
        <Card
            label="CURRENT EQUITY"
            value={fmtMoney(currentEquity, 0)}
            sub="Starting + realized + unrealized"
        />
        <Card
            label="REALIZED P&L"
            value={signed(realized)}
            valueClass={realized >= 0 ? "up" : "dn"}
            sub="Σ P&L of closed trades since reset"
        />
        <Card
            label="UNREALIZED P&L"
            value={signed(unrealized)}
            valueClass={unrealized >= 0 ? "up" : "dn"}
            sub="Open positions, marked-to-market"
        />
        <Card
            label="NET CHANGE"
            value={
                <>
                    {signed(equityDelta)}{" "}
                    <span style={{ fontSize: 12, opacity: 0.7 }}>
                        ({equityPct >= 0 ? "+" : ""}
                        {(equityPct * 100).toFixed(1)}%)
                    </span>
                </>
            }
            valueClass={equityDelta >= 0 ? "up" : "dn"}
            sub="Realized + unrealized = current − starting"
        />
    </div>
    );
        };

    const closed = React.useMemo(
          () =>
    (trades || [])
              .filter((t) => t.pnl != null && t.ts >= resetAt)
              .sort((a, b) => (a.exitTs || a.ts) - (b.exitTs || b.ts)),
    [trades, resetAt],
    );

    if (!closed.length)
    return (
    <div className="page" data-screen-label="09 P/L Trend">
        <div className="page-head">
            <div className="page-eyebrow">
                Portfolio performance · since last reset
            </div>
            <h1 className="page-title">P/L trend</h1>
            <p className="page-sub">No closed trades since last reset.</p>
        </div>
        <EquityHeader />
    </div>
    );

    let cum = 0;
    // Equity after each closed trade = startEquity + cumulative realized P&L.
    // Prepend startEquity so the chart starts at the reset baseline.
    const equitySeries = [
    startEquity,
          ...closed.map((t) => {
        cum += t.pnl;
    return startEquity + cum;
          }),
    ];
    const totalPnl = cum;
    let cumRun = 0;
    const cumPnlSeries = [
    0,
          ...closed.map((t) => {
        cumRun += t.pnl;
    return cumRun;
          }),
    ];
    const timeLabels = [
    "start",
          ...closed.map((t) => {
            const utc = new Date(t.exitTs || t.ts);
    const et = new Date(
    utc.toLocaleString("en-US", {timeZone: "America/New_York" }),
    );
    return `${et.getMonth() + 1}/${et.getDate()} ${String(et.getHours()).padStart(2, "0")}:${String(et.getMinutes()).padStart(2, "0")} ET`;
          }),
    ];
        const wins = closed.filter((t) => t.pnl > 0);
        const losses = closed.filter((t) => t.pnl <= 0);
    const winRate = closed.length ? wins.length / closed.length : 0;
    const avgWin = wins.length
          ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length
    : 0;
    const avgLoss = losses.length
          ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length
    : 0;
        // Max drawdown computed on equity series (peak-to-trough), unchanged in dollars.
        const maxDD = equitySeries.reduce((dd, v, i, a) => {
          const peak = Math.max(...a.slice(0, i + 1));
    return Math.min(dd, v - peak);
        }, 0);

    return (
    <div className="page" data-screen-label="09 P/L Trend">
        <div className="page-head">
            <div className="page-eyebrow">
                Portfolio performance · since last reset
            </div>
            <h1 className="page-title">
                Cumulative{" "}
                <em className={totalPnl >= 0 ? "up" : "dn"}>
                    {totalPnl >= 0 ? "gain" : "loss"}
                </em>{" "}
                across {closed.length} closed trade
                {closed.length !== 1 ? "s" : ""}
            </h1>
        </div>

        <EquityHeader />

        <div
            style={{
                display: "grid",
                gridTemplateColumns: "repeat(5,1fr)",
                gap: 12,
                marginBottom: 16,
            }}
        >
            {[
                {
                    label: "TOTAL P&L",
                    val: fmtMoney(totalPnl),
                    cls: totalPnl >= 0 ? "up" : "dn",
                },
                {
                    label: "WIN RATE",
                    val: (winRate * 100).toFixed(1) + "%",
                    cls: winRate >= 0.5 ? "up" : "dn",
                },
                { label: "AVG WIN", val: fmtMoney(avgWin), cls: "up" },
                { label: "AVG LOSS", val: fmtMoney(avgLoss), cls: "dn" },
                { label: "MAX DRAWDN", val: fmtMoney(maxDD), cls: "dn" },
            ].map((k) => (
                <div
                    key={k.label}
                    className="card"
                    style={{ padding: "14px 16px" }}
                >
                    <div
                        className="mono tiny muted"
                        style={{ letterSpacing: "0.1em", marginBottom: 6 }}
                    >
                        {k.label}
                    </div>
                    <div className={"mono " + k.cls} style={{ fontSize: 18 }}>
                        {k.val}
                    </div>
                </div>
            ))}
        </div>

        <div
            style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 12,
                marginBottom: 16,
            }}
        >
            <div className="card">
                <div className="card-head">
                    <div className="card-title">Equity after each trade</div>
                    <div className="card-meta">
                        {closed.length} trades · starting at{" "}
                        {fmtMoney(startEquity, 0)}
                    </div>
                </div>
                <LineChart
                    series={[equitySeries]}
                    zeroCrossColors={["var(--up)", "var(--down)"]}
                    crossValue={startEquity}
                    labels={["Equity"]}
                    height={220}
                    yFmt={(v) => fmtMoney(v, 0)}
                    fillFirst={true}
                    xLabels={timeLabels}
                    hLines={[
                        {
                            value: startEquity,
                            color: "var(--ink-4)",
                            label: "start " + fmtMoney(startEquity, 0),
                        },
                    ]}
                />
            </div>
            <div className="card">
                <div className="card-head">
                    <div className="card-title">
                        Cumulative P&amp;L after each trade
                    </div>
                    <div className="card-meta">
                        {closed.length} closed trades · realized only
                    </div>
                </div>
                <LineChart
                    series={[cumPnlSeries]}
                    zeroCrossColors={["var(--up)", "var(--down)"]}
                    crossValue={0}
                    labels={["Cum P&L"]}
                    height={220}
                    yFmt={(v) => (v >= 0 ? "+" : "") + fmtMoney(v, 0)}
                    fillFirst={true}
                    xLabels={timeLabels}
                    hLines={[
                        { value: 0, color: "var(--ink-4)", label: "breakeven" },
                    ]}
                />
            </div>
        </div>

        <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-head">
                <div className="card-title">Per-trade P&L</div>
                <div className="card-meta">
                    {wins.length}W · {losses.length}L · green above zero, red
                    below
                </div>
            </div>
            <PnlBars trades={closed} />
            <div
                style={{
                    marginTop: 10,
                    display: "flex",
                    flexWrap: "wrap",
                    gap: 8,
                }}
            >
                {closed
                    .slice(-12)
                    .reverse()
                    .map((t) => (
                        <div
                            key={t.id}
                            style={{
                                fontFamily: "var(--mono)",
                                fontSize: 10,
                                padding: "4px 8px",
                                borderRadius: 3,
                                background: "var(--bg-2)",
                                color: t.pnl > 0 ? "var(--up)" : "var(--down)",
                            }}
                        >
                            {t.sym} {t.side} {t.pnl >= 0 ? "+" : ""}
                            {fmtMoney(t.pnl, 0)}
                        </div>
                    ))}
            </div>
        </div>
    </div>
    );
      };

    // ── ScreenSectorUniverse ──────────────────────────────────────────────────────
    const ScreenSectorUniverse = ({mode, ctx}) => {
        const {
        trades = [],
        risk = {},
        liveSignals,
        agentWeights = {},
        dynamicExcluded,
        } = ctx;

    const allSectors = React.useMemo(
          () => [...new Set(TICKERS.map((t) => t.sector))],
    [],
    );

    const symToSector = React.useMemo(
          () => Object.fromEntries(TICKERS.map((t) => [t.sym, t.sector])),
    [],
    );

        const sectorStats = React.useMemo(() => {
          return allSectors
            .map((sect) => {
              const sectTrades = trades.filter(
                (t) => symToSector[t.sym] === sect,
    );
              const open = sectTrades.filter((t) => t.status === "OPEN").length;
              const closed = sectTrades.filter((t) => t.status !== "OPEN");
              const realizedPnl = closed.reduce((s, t) => s + (t.pnl || 0), 0);
    return {
        sect,
        total: sectTrades.length,
    open,
    closed: closed.length,
    realizedPnl,
              };
            })
            .sort((a, b) => b.total - a.total);
        }, [trades, allSectors, symToSector]);

    const totalTrades = trades.length;
        const openCount = trades.filter((t) => t.status === "OPEN").length;
    const closedCount = totalTrades - openCount;

    const confThreshold = risk.confidence ?? 55;

        const tickerConf = React.useMemo(() => {
          const sigSrc = liveSignals || SIGNALS_ALL;
    const wts = agentWeights || { };
    const enabledSet =
            dynamicExcluded?.size > 0
    ? new Set(
                  AGENTS.map((a) => a.id).filter(
                    (id) => !dynamicExcluded.has(id),
    ),
    )
    : null;
    const threshold = confThreshold / 100;

          return TICKERS.map((tk) => {
            const sigs = sigSrc[tk.sym];
    if (!sigs) {
              return {
        ...tk,
        ens: null,
    low: true,
    buyCount: 0,
    sellCount: 0,
    holdCount: AGENTS.length,
    tradeCount: 0,
              };
            }
    const ens = computeEnsemble(sigs, wts, enabledSet);
            const buyCount = AGENTS.filter((a) => ens.votes[a.id] === 1).length;
    const sellCount = AGENTS.filter(
              (a) => ens.votes[a.id] === -1,
    ).length;
    const holdCount = AGENTS.length - buyCount - sellCount;
            const tradeCount = trades.filter((t) => t.sym === tk.sym).length;
    return {
        ...tk,
        ens,
        buyCount,
        sellCount,
        holdCount,
        low: ens.confidence < threshold,
    tradeCount,
            };
          }).sort(
            (a, b) => (b.ens?.confidence ?? 0) - (a.ens?.confidence ?? 0),
    );
        }, [liveSignals, agentWeights, dynamicExcluded, confThreshold, trades]);

        const lowConfCount = tickerConf.filter((t) => t.low && t.ens).length;
        const activeSectors = sectorStats.filter((s) => s.total > 0).length;

    // Herfindahl concentration index — 0 = perfect spread, 1 = all one sector
    const hhi =
          totalTrades > 0
            ? sectorStats.reduce((s, x) => s + (x.total / totalTrades) ** 2, 0)
    : 0;
    const diversityScore = Math.round((1 - hhi) * 100);
    const diversityLabel =
    hhi < 0.25
    ? "Well diversified"
    : hhi < 0.4
    ? "Moderate"
    : "Concentrated";

    return (
    <div style={{ padding: "0 0 40px" }}>
        {/* KPI strip */}
        <div
            style={{
                display: "flex",
                gap: 12,
                marginBottom: 16,
                flexWrap: "wrap",
            }}
        >
            {[
                {
                    label: "Total trades",
                    value: totalTrades,
                    sub: openCount + " open · " + closedCount + " closed",
                },
                {
                    label: "Active sectors",
                    value: activeSectors,
                    sub: "of " + allSectors.length + " in universe",
                },
                {
                    label: "Diversity score",
                    value: diversityScore + "%",
                    sub: diversityLabel,
                },
                {
                    label: "Low confidence",
                    value: lowConfCount,
                    sub: "tickers below " + confThreshold + "% threshold",
                },
            ].map(({ label, value, sub }) => (
                <div
                    key={label}
                    className="card"
                    style={{
                        flex: "1 1 130px",
                        minWidth: 120,
                        padding: "12px 16px",
                    }}
                >
                    <div
                        style={{
                            fontSize: 10,
                            color: "var(--ink-4)",
                            textTransform: "uppercase",
                            letterSpacing: "0.08em",
                            marginBottom: 4,
                        }}
                    >
                        {label}
                    </div>
                    <div
                        style={{
                            fontFamily: "var(--mono)",
                            fontSize: 22,
                            fontWeight: 700,
                        }}
                    >
                        {value}
                    </div>
                    <div
                        style={{
                            fontSize: 11,
                            color: "var(--ink-4)",
                            marginTop: 2,
                        }}
                    >
                        {sub}
                    </div>
                </div>
            ))}
        </div>

        {/* Sector distribution — SVG bar chart + stats table */}
        {(() => {
            const maxTotal = Math.max(1, ...sectorStats.map((s) => s.total));
            const barH = 28,
                gap = 6,
                labelW = 56;
            const chartH = sectorStats.length * (barH + gap);
            const sectorColors = {
                Tech: "#7dd87d",
                Fin: "#7ec0ee",
                Energy: "#f0c674",
                Health: "#c594c5",
                Cons: "#f4a87c",
                Auto: "#ff8a3d",
                Indus: "#9dc4e8",
                Util: "#b0a8e0",
                Mat: "#e08a8a",
            };
            return (
                <div className="card" style={{ marginBottom: 16 }}>
                    <div className="card-head">
                        <div className="card-title">Sector Distribution</div>
                        <div className="card-meta">
                            Trade counts · sector cap {risk.maxSectorPct ?? 40}% ·
                            gate at ≥5 open positions
                        </div>
                    </div>
                    <div
                        style={{
                            display: "grid",
                            gridTemplateColumns: "1fr 1fr",
                            gap: 20,
                            alignItems: "start",
                        }}
                    >
                        {/* Bar chart */}
                        <svg
                            width="100%"
                            viewBox={`0 0 400 ${chartH}`}
                            style={{ overflow: "visible" }}
                        >
                            {sectorStats.map(({ sect, total, open }, idx) => {
                                const y = idx * (barH + gap);
                                const barW = total > 0 ? (total / maxTotal) * 300 : 0;
                                const openW = open > 0 ? (open / maxTotal) * 300 : 0;
                                const color = sectorColors[sect] || "#888";
                                return (
                                    <g key={sect}>
                                        <text
                                            x={labelW - 6}
                                            y={y + barH / 2 + 4}
                                            textAnchor="end"
                                            fill="currentColor"
                                            fontSize="11"
                                            fontFamily="var(--mono)"
                                            fontWeight="600"
                                        >
                                            {sect}
                                        </text>
                                        <rect
                                            x={labelW}
                                            y={y + 2}
                                            width="300"
                                            height={barH - 4}
                                            rx="3"
                                            fill="var(--bg-3)"
                                            opacity="0.5"
                                        />
                                        {barW > 0 && (
                                            <rect
                                                x={labelW}
                                                y={y + 2}
                                                width={barW}
                                                height={barH - 4}
                                                rx="3"
                                                fill={color}
                                                opacity="0.35"
                                            />
                                        )}
                                        {openW > 0 && (
                                            <rect
                                                x={labelW}
                                                y={y + 2}
                                                width={openW}
                                                height={barH - 4}
                                                rx="3"
                                                fill={color}
                                                opacity="0.8"
                                            />
                                        )}
                                        <text
                                            x={labelW + Math.max(barW, 0) + 6}
                                            y={y + barH / 2 + 4}
                                            fill="currentColor"
                                            fontSize="11"
                                            fontFamily="var(--mono)"
                                            opacity={total > 0 ? 1 : 0.3}
                                        >
                                            {total}
                                        </text>
                                        {open > 0 && (
                                            <text
                                                x={labelW + openW + 6}
                                                y={y + barH / 2 + 4}
                                                fill={color}
                                                fontSize="9"
                                                fontFamily="var(--mono)"
                                                opacity="0.9"
                                            >
                                                {open} open
                                            </text>
                                        )}
                                    </g>
                                );
                            })}
                        </svg>
                        {/* Stats table */}
                        <div>
                            <div
                                style={{
                                    display: "grid",
                                    gridTemplateColumns: "56px 50px 50px 80px 60px",
                                    gap: 4,
                                    padding: "0 0 6px",
                                    borderBottom: "1px solid var(--bg-3)",
                                    marginBottom: 4,
                                }}
                            >
                                {["Sector", "Total", "Open", "P&L", "Conf"].map(
                                    (h, i) => (
                                        <div
                                            key={i}
                                            style={{
                                                fontSize: 9,
                                                color: "var(--ink-4)",
                                                textAlign: i > 0 ? "right" : "left",
                                                textTransform: "uppercase",
                                                letterSpacing: "0.08em",
                                            }}
                                        >
                                            {h}
                                        </div>
                                    ),
                                )}
                            </div>
                            {sectorStats.map(
                                ({ sect, total, open, closed, realizedPnl }) => {
                                    const sectConf = tickerConf.filter(
                                        (tc) => tc.sector === sect && tc.ens,
                                    );
                                    const avgConf =
                                        sectConf.length > 0
                                            ? sectConf.reduce(
                                                (s, tc) => s + tc.ens.confidence,
                                                0,
                                            ) / sectConf.length
                                            : 0;
                                    const confOk = avgConf * 100 >= confThreshold;
                                    return (
                                        <div
                                            key={sect}
                                            style={{
                                                display: "grid",
                                                gridTemplateColumns: "56px 50px 50px 80px 60px",
                                                gap: 4,
                                                padding: "5px 0",
                                                borderBottom: "1px solid var(--bg-3)",
                                            }}
                                        >
                                            <div
                                                style={{
                                                    fontFamily: "var(--mono)",
                                                    fontSize: 11,
                                                    fontWeight: 600,
                                                    color: sectorColors[sect] || "var(--ink)",
                                                }}
                                            >
                                                {sect}
                                            </div>
                                            <div
                                                style={{
                                                    fontFamily: "var(--mono)",
                                                    fontSize: 11,
                                                    textAlign: "right",
                                                    color:
                                                        total > 0 ? "var(--ink-2)" : "var(--ink-4)",
                                                }}
                                            >
                                                {total}
                                            </div>
                                            <div
                                                style={{
                                                    fontFamily: "var(--mono)",
                                                    fontSize: 11,
                                                    textAlign: "right",
                                                }}
                                            >
                                                {open > 0 ? (
                                                    <span style={{ color: "var(--accent)" }}>
                                                        {open}
                                                    </span>
                                                ) : (
                                                    <span style={{ color: "var(--ink-4)" }}>
                                                        0
                                                    </span>
                                                )}
                                            </div>
                                            <div
                                                style={{
                                                    fontFamily: "var(--mono)",
                                                    fontSize: 11,
                                                    textAlign: "right",
                                                    color:
                                                        realizedPnl > 0
                                                            ? "var(--up)"
                                                            : realizedPnl < 0
                                                                ? "var(--down)"
                                                                : "var(--ink-4)",
                                                }}
                                            >
                                                {realizedPnl !== 0
                                                    ? (realizedPnl > 0 ? "+" : "") +
                                                    fmtMoney(realizedPnl, 0)
                                                    : "—"}
                                            </div>
                                            <div
                                                style={{
                                                    fontFamily: "var(--mono)",
                                                    fontSize: 11,
                                                    textAlign: "right",
                                                    color:
                                                        total > 0
                                                            ? confOk
                                                                ? "var(--up)"
                                                                : "var(--warn)"
                                                            : "var(--ink-4)",
                                                }}
                                            >
                                                {total > 0
                                                    ? Math.round(avgConf * 100) + "%"
                                                    : "—"}
                                            </div>
                                        </div>
                                    );
                                },
                            )}
                        </div>
                    </div>
                </div>
            );
        })()}

        {/* Universe confidence map */}
        <div className="card">
            <div className="card-head">
                <div className="card-title">Universe Confidence Map</div>
                <div className="card-meta">
                    {lowConfCount} ticker{lowConfCount !== 1 ? "s" : ""} flagged
                    below {confThreshold}% · sorted by confidence desc
                </div>
            </div>
            <div
                style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
                    gap: 8,
                }}
            >
                {tickerConf.map((tc) => {
                    const confPct = tc.ens
                        ? Math.round(tc.ens.confidence * 100)
                        : 0;
                    const dir = tc.ens?.dir;
                    const isLow = tc.low && tc.ens;
                    const barColor = isLow
                        ? "var(--warn)"
                        : dir === "BUY"
                            ? "var(--up)"
                            : dir === "SELL"
                                ? "var(--down)"
                                : "var(--accent)";
                    return (
                        <div
                            key={tc.sym}
                            style={{
                                background: "var(--bg-2)",
                                border: isLow
                                    ? "1px solid var(--warn)"
                                    : "1px solid var(--bg-3)",
                                borderRadius: 6,
                                padding: "10px 12px",
                                position: "relative",
                            }}
                        >
                            {isLow && (
                                <div
                                    style={{
                                        position: "absolute",
                                        top: 7,
                                        right: 8,
                                        fontSize: 8,
                                        color: "var(--warn)",
                                        fontFamily: "var(--mono)",
                                        fontWeight: 700,
                                        letterSpacing: "0.06em",
                                    }}
                                >
                                    ⚠ LOW CONF
                                </div>
                            )}
                            {/* Header */}
                            <div
                                style={{
                                    display: "flex",
                                    justifyContent: "space-between",
                                    alignItems: "flex-start",
                                    marginBottom: 8,
                                }}
                            >
                                <div>
                                    <div
                                        style={{
                                            fontFamily: "var(--mono)",
                                            fontWeight: 700,
                                            fontSize: 14,
                                        }}
                                    >
                                        {tc.sym}
                                    </div>
                                    <div
                                        style={{
                                            fontSize: 11,
                                            color: "var(--ink-3)",
                                            marginTop: 1,
                                        }}
                                    >
                                        {tc.name}
                                    </div>
                                </div>
                                <div
                                    style={{
                                        display: "flex",
                                        flexDirection: "column",
                                        alignItems: "flex-end",
                                        gap: 3,
                                    }}
                                >
                                    <span
                                        style={{
                                            fontSize: 10,
                                            background: "var(--bg-3)",
                                            padding: "1px 6px",
                                            borderRadius: 3,
                                            fontFamily: "var(--mono)",
                                            color: "var(--ink-3)",
                                        }}
                                    >
                                        {tc.sector}
                                    </span>
                                    {tc.tradeCount > 0 && (
                                        <span
                                            style={{
                                                fontSize: 10,
                                                color: "var(--ink-4)",
                                                fontFamily: "var(--mono)",
                                            }}
                                        >
                                            {tc.tradeCount} trade
                                            {tc.tradeCount !== 1 ? "s" : ""}
                                        </span>
                                    )}
                                </div>
                            </div>
                            {/* Confidence bar */}
                            <div style={{ marginBottom: 7 }}>
                                <div
                                    style={{
                                        display: "flex",
                                        justifyContent: "space-between",
                                        marginBottom: 3,
                                    }}
                                >
                                    <span style={{ fontSize: 10, color: "var(--ink-4)" }}>
                                        Confidence
                                    </span>
                                    <span
                                        style={{
                                            fontFamily: "var(--mono)",
                                            fontSize: 11,
                                            color: barColor,
                                            fontWeight: 700,
                                        }}
                                    >
                                        {tc.ens ? confPct + "%" : "no signal"}
                                    </span>
                                </div>
                                <div
                                    style={{
                                        height: 4,
                                        background: "var(--bg-3)",
                                        borderRadius: 2,
                                        overflow: "hidden",
                                    }}
                                >
                                    <div
                                        style={{
                                            height: "100%",
                                            width: confPct + "%",
                                            background: barColor,
                                            borderRadius: 2,
                                            transition: "width 0.4s",
                                        }}
                                    />
                                </div>
                                {/* Threshold tick */}
                                <div style={{ position: "relative", height: 3 }}>
                                    <div
                                        style={{
                                            position: "absolute",
                                            left: confThreshold + "%",
                                            top: 0,
                                            width: 1,
                                            height: 3,
                                            background: "var(--ink-4)",
                                            opacity: 0.5,
                                        }}
                                    />
                                </div>
                            </div>
                            {/* Direction + vote breakdown */}
                            {tc.ens ? (
                                <div
                                    style={{
                                        display: "flex",
                                        alignItems: "center",
                                        gap: 8,
                                    }}
                                >
                                    <span
                                        style={{
                                            fontSize: 10,
                                            fontFamily: "var(--mono)",
                                            fontWeight: 700,
                                            color:
                                                dir === "BUY"
                                                    ? "var(--up)"
                                                    : dir === "SELL"
                                                        ? "var(--down)"
                                                        : "var(--ink-3)",
                                            minWidth: 28,
                                        }}
                                    >
                                        {dir || "HOLD"}
                                    </span>
                                    <div
                                        style={{
                                            display: "flex",
                                            gap: 5,
                                            fontSize: 10,
                                            fontFamily: "var(--mono)",
                                            color: "var(--ink-3)",
                                        }}
                                    >
                                        <span style={{ color: "var(--up)" }}>
                                            {tc.buyCount}↑
                                        </span>
                                        <span style={{ color: "var(--down)" }}>
                                            {tc.sellCount}↓
                                        </span>
                                        <span style={{ color: "var(--ink-4)" }}>
                                            {tc.holdCount}–
                                        </span>
                                    </div>
                                    <span
                                        style={{
                                            marginLeft: "auto",
                                            fontSize: 10,
                                            color: "var(--ink-4)",
                                            fontFamily: "var(--mono)",
                                        }}
                                    >
                                        {Math.round((tc.ens.disagreement ?? 0) * 100)}%
                                        split
                                    </span>
                                </div>
                            ) : (
                                <div style={{ fontSize: 10, color: "var(--ink-4)" }}>
                                    No signal data
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    </div>
    );
      };

    // ── ScreenAgentConfig ─────────────────────────────────────────────────────────
    const ScreenAgentConfig = ({
        agentParams,
        setAgentParams,
        enabledAgents,
        setEnabledAgents,
        agentWeights,
        agentHistory,
        agentParamPresets = {},
        setAgentParamPresets = () => { },
      }) => {
        const [optimizing, setOptimizing] = React.useState({ });
    const [optResults, setOptResults] = React.useState({ });
    const [expanded, setExpanded] = React.useState({ });
    const [presetName, setPresetName] = React.useState("");
    const [selectedPreset, setSelectedPreset] = React.useState("");
    const [confirmRevert, setConfirmRevert] = React.useState(false);
    const [showAllParams, setShowAllParams] = React.useState(false);

        const gp = (id, key) =>
    agentParams[id]?.[key] ?? AGENT_PARAMS_DEFAULT[id]?.[key];
        const sp = (id, key, val) =>
          setAgentParams((p) => ({
        ...p,
        [id]: {...(p[id] || {}), [key]: val },
          }));

        // Count how many params differ from defaults (across all agents).
        const modifiedCount = React.useMemo(() => {
        let n = 0;
    for (const a of AGENTS) {
            const defs = AGENT_PARAM_DEFS[a.id] || [];
    for (const def of defs) {
              const cur = agentParams[a.id]?.[def.key];
    const dflt = AGENT_PARAMS_DEFAULT[a.id]?.[def.key];
    if (
    cur !== undefined &&
    dflt !== undefined &&
                Math.abs(cur - dflt) > def.step * 0.5
    )
    n++;
            }
          }
    return n;
        }, [agentParams]);
        const totalParamCount = React.useMemo(() => {
          return AGENTS.reduce(
            (s, a) => s + (AGENT_PARAM_DEFS[a.id]?.length || 0),
    0,
    );
        }, []);

    const presetNames = Object.keys(agentParamPresets);

        const savePreset = () => {
          const name = (presetName || "").trim();
    if (!name) return;
          setAgentParamPresets((p) => ({
        ...p,
        [name]: JSON.parse(JSON.stringify(agentParams)),
          }));
    setPresetName("");
    setSelectedPreset(name);
        };
        const loadPreset = (name) => {
          if (!name || !agentParamPresets[name]) return;
          setAgentParamPresets((p) => p); // no-op, just touching
    setAgentParams(JSON.parse(JSON.stringify(agentParamPresets[name])));
    setSelectedPreset(name);
        };
        const deletePreset = (name) => {
          if (!name) return;
          setAgentParamPresets((p) => {
            const next = {...p};
    delete next[name];
    return next;
          });
    if (selectedPreset === name) setSelectedPreset("");
        };
        const revertAll = () => {
        setAgentParams({});
    setOptResults({ });
    setSelectedPreset("");
    setConfirmRevert(false);
        };

        const optimize = async (agentId) => {
        setOptimizing((o) => ({ ...o, [agentId]: true }));
    const result = await backtestOneAgent(agentId, "NVDA", agentParams);
    if (result) sp(agentId, result.paramKey, result.bestValue);
          setOptResults((o) => ({...o, [agentId]: result }));
          setOptimizing((o) => ({...o, [agentId]: false }));
        };

    const [optimizingAll, setOptimizingAll] = React.useState(false);
        const optimizeAll = async () => {
          if (optimizingAll) return;
    setOptimizingAll(true);
    for (const a of AGENTS) {
        await optimize(a.id);
          }
    setOptimizingAll(false);
        };

        const families = [...new Set(AGENTS.map((a) => a.family))];
    const enabledCount = enabledAgents ? enabledAgents.size : AGENTS.length;

    return (
    <div className="page" data-screen-label="10 Agent Config">
        <div className="page-head">
            <div className="page-eyebrow">
                Agent configuration · {enabledCount}/{AGENTS.length} active
            </div>
            <h1 className="page-title">
                Toggle, tune, and <em>optimise</em> each agent.
            </h1>
            <p className="page-sub">
                Enable or disable agents, adjust their signal parameters, and
                run a walk-forward grid search to find the best setting for each
                param against your price history.
            </p>
        </div>

        <div className="card" style={{ marginBottom: 16, padding: 14 }}>
            <div
                style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 12,
                    flexWrap: "wrap",
                }}
            >
                <div
                    style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 14,
                        flexWrap: "wrap",
                    }}
                >
                    <div>
                        <div
                            className="mono tiny muted"
                            style={{ letterSpacing: "0.1em" }}
                        >
                            PARAMS MODIFIED
                        </div>
                        <div
                            className="mono"
                            style={{
                                fontSize: 16,
                                color:
                                    modifiedCount > 0 ? "var(--warn)" : "var(--ink-2)",
                            }}
                        >
                            {modifiedCount}{" "}
                            <span style={{ fontSize: 11, color: "var(--ink-4)" }}>
                                / {totalParamCount}
                            </span>
                        </div>
                    </div>
                    <div>
                        <div
                            className="mono tiny muted"
                            style={{ letterSpacing: "0.1em" }}
                        >
                            ACTIVE PRESET
                        </div>
                        <div
                            className="mono"
                            style={{
                                fontSize: 13,
                                color: selectedPreset
                                    ? "var(--virtual)"
                                    : "var(--ink-3)",
                            }}
                        >
                            {selectedPreset ||
                                (modifiedCount === 0 ? "defaults" : "custom (unsaved)")}
                        </div>
                    </div>
                </div>
                <div
                    style={{
                        display: "flex",
                        gap: 8,
                        flexWrap: "wrap",
                        alignItems: "center",
                    }}
                >
                    <button
                        className="btn"
                        style={{ fontSize: 11 }}
                        onClick={() => setShowAllParams((s) => !s)}
                    >
                        {showAllParams ? "Hide all params" : "View all params"}
                    </button>
                    <button
                        className="btn"
                        style={{ fontSize: 11 }}
                        onClick={() =>
                            setEnabledAgents(new Set(AGENTS.map((a) => a.id)))
                        }
                    >
                        Enable all
                    </button>
                    <button
                        className="btn"
                        style={{ fontSize: 11, opacity: optimizingAll ? 0.5 : 1 }}
                        onClick={optimizeAll}
                        disabled={optimizingAll}
                    >
                        {optimizingAll ? "⟳ Optimising…" : "⚡ Optimise all"}
                    </button>
                    {confirmRevert ? (
                        <React.Fragment>
                            <span
                                className="mono tiny"
                                style={{ color: "var(--warn)" }}
                            >
                                Sure?
                            </span>
                            <button
                                className="btn"
                                style={{ fontSize: 11, color: "var(--down)" }}
                                onClick={revertAll}
                            >
                                Yes, revert
                            </button>
                            <button
                                className="btn"
                                style={{ fontSize: 11 }}
                                onClick={() => setConfirmRevert(false)}
                            >
                                Cancel
                            </button>
                        </React.Fragment>
                    ) : (
                        <button
                            className="btn"
                            style={{
                                fontSize: 11,
                                opacity: modifiedCount === 0 ? 0.4 : 1,
                            }}
                            disabled={modifiedCount === 0}
                            onClick={() => setConfirmRevert(true)}
                        >
                            Revert to defaults
                        </button>
                    )}
                </div>
            </div>

            <div
                style={{
                    borderTop: "1px solid var(--line)",
                    marginTop: 12,
                    paddingTop: 12,
                    display: "flex",
                    gap: 10,
                    flexWrap: "wrap",
                    alignItems: "center",
                }}
            >
                <span
                    className="mono tiny muted"
                    style={{ letterSpacing: "0.1em" }}
                >
                    PRESETS
                </span>
                <select
                    value={selectedPreset}
                    onChange={(e) => {
                        setSelectedPreset(e.target.value);
                    }}
                    style={{
                        fontFamily: "var(--mono)",
                        fontSize: 11,
                        padding: "4px 8px",
                        background: "var(--bg-2)",
                        color: "var(--ink)",
                        border: "1px solid var(--line)",
                        borderRadius: 3,
                    }}
                >
                    <option value="">— choose preset —</option>
                    {presetNames.map((n) => (
                        <option key={n} value={n}>
                            {n}
                        </option>
                    ))}
                </select>
                <button
                    className="btn"
                    style={{ fontSize: 11, opacity: selectedPreset ? 1 : 0.4 }}
                    disabled={!selectedPreset}
                    onClick={() => loadPreset(selectedPreset)}
                >
                    Load
                </button>
                <button
                    className="btn"
                    style={{
                        fontSize: 11,
                        opacity: selectedPreset ? 1 : 0.4,
                        color: "var(--down)",
                    }}
                    disabled={!selectedPreset}
                    onClick={() => deletePreset(selectedPreset)}
                >
                    Delete
                </button>
                <span style={{ flex: 1 }} />
                <input
                    type="text"
                    value={presetName}
                    onChange={(e) => setPresetName(e.target.value)}
                    placeholder="preset name…"
                    style={{
                        fontFamily: "var(--mono)",
                        fontSize: 11,
                        padding: "4px 8px",
                        background: "var(--bg-2)",
                        color: "var(--ink)",
                        border: "1px solid var(--line)",
                        borderRadius: 3,
                        width: 160,
                    }}
                />
                <button
                    className="btn"
                    style={{ fontSize: 11, opacity: presetName.trim() ? 1 : 0.4 }}
                    disabled={!presetName.trim()}
                    onClick={savePreset}
                >
                    Save as preset
                </button>
            </div>
            {presetNames.length === 0 && (
                <div className="mono tiny muted" style={{ marginTop: 8 }}>
                    No saved presets yet. Tweak any agent's params, then type a
                    name and click <em>Save as preset</em>. Loading a preset
                    overwrites current values; reverting wipes them back to
                    defaults.
                </div>
            )}
        </div>

        {showAllParams && (
            <div className="card" style={{ marginBottom: 16, padding: 14 }}>
                <div className="card-head" style={{ marginBottom: 10 }}>
                    <div className="card-title">All agent params · overview</div>
                    <div className="card-meta">
                        {modifiedCount} of {totalParamCount} modified
                    </div>
                </div>
                <div style={{ overflowX: "auto" }}>
                    <table
                        style={{
                            width: "100%",
                            borderCollapse: "collapse",
                            fontFamily: "var(--mono)",
                            fontSize: 10,
                        }}
                    >
                        <thead>
                            <tr
                                style={{
                                    textAlign: "left",
                                    color: "var(--ink-3)",
                                    borderBottom: "1px solid var(--line)",
                                }}
                            >
                                <th style={{ padding: "6px 8px" }}>Agent</th>
                                <th style={{ padding: "6px 8px" }}>Param</th>
                                <th style={{ padding: "6px 8px", textAlign: "right" }}>
                                    Current
                                </th>
                                <th style={{ padding: "6px 8px", textAlign: "right" }}>
                                    Default
                                </th>
                                <th style={{ padding: "6px 8px" }}>State</th>
                            </tr>
                        </thead>
                        <tbody>
                            {AGENTS.flatMap((a) =>
                                (AGENT_PARAM_DEFS[a.id] || []).map((def) => {
                                    const cur = agentParams[a.id]?.[def.key];
                                    const dflt = AGENT_PARAMS_DEFAULT[a.id]?.[def.key];
                                    const eff = cur !== undefined ? cur : dflt;
                                    const modified =
                                        cur !== undefined &&
                                        dflt !== undefined &&
                                        Math.abs(cur - dflt) > def.step * 0.5;
                                    return (
                                        <tr
                                            key={a.id + ":" + def.key}
                                            style={{
                                                borderBottom: "1px solid var(--line-2)",
                                            }}
                                        >
                                            <td
                                                style={{ padding: "4px 8px", color: a.color }}
                                            >
                                                {a.glyph} {a.name}
                                            </td>
                                            <td
                                                style={{
                                                    padding: "4px 8px",
                                                    color: "var(--ink-2)",
                                                }}
                                            >
                                                {def.label}
                                            </td>
                                            <td
                                                style={{
                                                    padding: "4px 8px",
                                                    textAlign: "right",
                                                    color: modified
                                                        ? "var(--warn)"
                                                        : "var(--ink-2)",
                                                }}
                                            >
                                                {def.fmt(eff)}
                                            </td>
                                            <td
                                                style={{
                                                    padding: "4px 8px",
                                                    textAlign: "right",
                                                    color: "var(--ink-3)",
                                                }}
                                            >
                                                {def.fmt(dflt)}
                                            </td>
                                            <td
                                                style={{
                                                    padding: "4px 8px",
                                                    color: modified
                                                        ? "var(--warn)"
                                                        : "var(--ink-4)",
                                                }}
                                            >
                                                {modified ? "modified" : "default"}
                                            </td>
                                        </tr>
                                    );
                                }),
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
        )}

        {families.map((family) => (
            <div key={family} style={{ marginBottom: 24 }}>
                <div
                    style={{
                        fontFamily: "var(--mono)",
                        fontSize: 10,
                        letterSpacing: "0.14em",
                        color: "var(--ink-3)",
                        textTransform: "uppercase",
                        marginBottom: 10,
                        paddingBottom: 6,
                        borderBottom: "1px solid var(--line)",
                    }}
                >
                    {family}
                </div>
                <div
                    style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(auto-fill,minmax(290px,1fr))",
                        gap: 10,
                    }}
                >
                    {AGENTS.filter((a) => a.family === family).map((agent) => {
                        const enabled =
                            !enabledAgents || enabledAgents.has(agent.id);
                        const hist = agentHistory?.[agent.id] || [];
                        const acc =
                            (hist.length >= 5 ? decayAccuracy(hist) : null) ??
                            (hist.length >= 2
                                ? hist.filter(Boolean).length / hist.length
                                : agent.accuracy);
                        const w = agentWeights?.[agent.id] ?? agent.weight;
                        const defs = AGENT_PARAM_DEFS[agent.id] || [];
                        const isExp = expanded[agent.id];
                        const optRes = optResults[agent.id];
                        const busy = optimizing[agent.id];
                        const canOpt = !!AGENT_OPTIMIZE_KEYS[agent.id]?.id;

                        return (
                            <div
                                key={agent.id}
                                className="card"
                                style={{
                                    opacity: enabled ? 1 : 0.42,
                                    transition: "opacity 0.2s",
                                    padding: 14,
                                }}
                            >
                                <div
                                    style={{
                                        display: "flex",
                                        alignItems: "flex-start",
                                        gap: 10,
                                    }}
                                >
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                        <div
                                            style={{
                                                display: "flex",
                                                alignItems: "center",
                                                gap: 6,
                                            }}
                                        >
                                            <span
                                                style={{
                                                    fontFamily: "var(--mono)",
                                                    fontSize: 15,
                                                    color: agent.color,
                                                }}
                                            >
                                                {agent.glyph}
                                            </span>
                                            <span style={{ fontWeight: 500, fontSize: 12 }}>
                                                {agent.name}
                                            </span>
                                        </div>
                                        <div
                                            style={{
                                                fontSize: 10,
                                                color: "var(--ink-3)",
                                                marginTop: 2,
                                                whiteSpace: "nowrap",
                                                overflow: "hidden",
                                                textOverflow: "ellipsis",
                                            }}
                                        >
                                            {agent.desc}
                                        </div>
                                    </div>
                                    <div
                                        style={{
                                            display: "flex",
                                            alignItems: "center",
                                            gap: 8,
                                            flexShrink: 0,
                                        }}
                                    >
                                        <span
                                            style={{
                                                fontFamily: "var(--mono)",
                                                fontSize: 10,
                                                color:
                                                    acc >= 0.6
                                                        ? "var(--up)"
                                                        : acc < 0.5
                                                            ? "var(--down)"
                                                            : "var(--ink-3)",
                                            }}
                                        >
                                            {(acc * 100).toFixed(0)}%
                                        </span>
                                        <button
                                            style={{
                                                width: 34,
                                                height: 18,
                                                borderRadius: 9,
                                                background: enabled
                                                    ? "var(--virtual)"
                                                    : "var(--line-2)",
                                                position: "relative",
                                                transition: "background 0.2s",
                                                flexShrink: 0,
                                                border: "none",
                                                cursor: "pointer",
                                            }}
                                            onClick={() =>
                                                setEnabledAgents((prev) => {
                                                    const next = new Set(
                                                        prev || AGENTS.map((a) => a.id),
                                                    );
                                                    next.has(agent.id)
                                                        ? next.delete(agent.id)
                                                        : next.add(agent.id);
                                                    return next;
                                                })
                                            }
                                        >
                                            <span
                                                style={{
                                                    position: "absolute",
                                                    top: 2,
                                                    left: enabled ? 18 : 2,
                                                    width: 14,
                                                    height: 14,
                                                    borderRadius: 7,
                                                    background: "white",
                                                    transition: "left 0.2s",
                                                }}
                                            />
                                        </button>
                                    </div>
                                </div>

                                {defs.length > 0 && (
                                    <div style={{ marginTop: 10 }}>
                                        <div
                                            style={{
                                                display: "flex",
                                                alignItems: "center",
                                                justifyContent: "space-between",
                                                gap: 8,
                                            }}
                                        >
                                            <button
                                                className="mono tiny muted"
                                                style={{
                                                    fontSize: 9,
                                                    letterSpacing: "0.06em",
                                                    cursor: "pointer",
                                                }}
                                                onClick={() =>
                                                    setExpanded((e) => ({
                                                        ...e,
                                                        [agent.id]: !isExp,
                                                    }))
                                                }
                                            >
                                                {isExp ? "▾ hide params" : "▸ params"}
                                            </button>
                                            {agentParams[agent.id] &&
                                                Object.keys(agentParams[agent.id]).length >
                                                0 && (
                                                    <button
                                                        className="mono tiny"
                                                        style={{
                                                            fontSize: 9,
                                                            letterSpacing: "0.04em",
                                                            cursor: "pointer",
                                                            color: "var(--warn)",
                                                        }}
                                                        onClick={() =>
                                                            setAgentParams((p) => {
                                                                const next = { ...p };
                                                                delete next[agent.id];
                                                                return next;
                                                            })
                                                        }
                                                        title="Revert this agent's params to defaults"
                                                    >
                                                        ↺ revert agent
                                                    </button>
                                                )}
                                        </div>
                                        {isExp && (
                                            <div
                                                style={{
                                                    marginTop: 8,
                                                    display: "flex",
                                                    flexDirection: "column",
                                                    gap: 8,
                                                }}
                                            >
                                                {defs.map((def) => {
                                                    const val = gp(agent.id, def.key);
                                                    const v =
                                                        val !== undefined
                                                            ? val
                                                            : (AGENT_PARAMS_DEFAULT[agent.id]?.[
                                                                def.key
                                                            ] ?? def.min);
                                                    const defVal =
                                                        AGENT_PARAMS_DEFAULT[agent.id]?.[def.key] ??
                                                        def.min;
                                                    const defPct =
                                                        ((defVal - def.min) / (def.max - def.min)) *
                                                        100;
                                                    const isModified =
                                                        Math.abs(v - defVal) > def.step * 0.5;
                                                    return (
                                                        <div key={def.key}>
                                                            <div
                                                                style={{
                                                                    display: "flex",
                                                                    justifyContent: "space-between",
                                                                    alignItems: "center",
                                                                    marginBottom: 3,
                                                                }}
                                                            >
                                                                <div
                                                                    style={{
                                                                        display: "flex",
                                                                        alignItems: "center",
                                                                        gap: 4,
                                                                    }}
                                                                >
                                                                    <span
                                                                        style={{
                                                                            fontFamily: "var(--mono)",
                                                                            fontSize: 9,
                                                                            color: "var(--ink-3)",
                                                                        }}
                                                                    >
                                                                        {def.label}
                                                                    </span>
                                                                    {def.hint && (
                                                                        <span
                                                                            title={def.hint}
                                                                            style={{
                                                                                cursor: "help",
                                                                                fontFamily: "var(--mono)",
                                                                                fontSize: 8,
                                                                                color: "var(--ink-4)",
                                                                                lineHeight: 1,
                                                                                borderRadius: "50%",
                                                                                border:
                                                                                    "1px solid var(--line-2)",
                                                                                width: 13,
                                                                                height: 13,
                                                                                display: "inline-flex",
                                                                                alignItems: "center",
                                                                                justifyContent: "center",
                                                                                flexShrink: 0,
                                                                            }}
                                                                        >
                                                                            ?
                                                                        </span>
                                                                    )}
                                                                </div>
                                                                <div
                                                                    style={{
                                                                        display: "flex",
                                                                        alignItems: "center",
                                                                        gap: 6,
                                                                    }}
                                                                >
                                                                    {isModified && (
                                                                        <span
                                                                            style={{
                                                                                fontFamily: "var(--mono)",
                                                                                fontSize: 8,
                                                                                color: "var(--warn)",
                                                                                letterSpacing: "0.04em",
                                                                            }}
                                                                        >
                                                                            modified
                                                                        </span>
                                                                    )}
                                                                    <span
                                                                        style={{
                                                                            fontFamily: "var(--mono)",
                                                                            fontSize: 9,
                                                                            color: isModified
                                                                                ? "var(--ink)"
                                                                                : "var(--ink-2)",
                                                                        }}
                                                                    >
                                                                        {def.fmt(v)}
                                                                    </span>
                                                                </div>
                                                            </div>
                                                            <div style={{ position: "relative" }}>
                                                                <input
                                                                    type="range"
                                                                    min={def.min}
                                                                    max={def.max}
                                                                    step={def.step}
                                                                    value={v}
                                                                    onChange={(e) =>
                                                                        sp(
                                                                            agent.id,
                                                                            def.key,
                                                                            parseFloat(e.target.value),
                                                                        )
                                                                    }
                                                                    style={{
                                                                        width: "100%",
                                                                        accentColor: agent.color,
                                                                    }}
                                                                />
                                                                {/* default-value tick mark */}
                                                                <div
                                                                    style={{
                                                                        position: "absolute",
                                                                        bottom: -6,
                                                                        left: `calc(${defPct}% - 1px)`,
                                                                        width: 2,
                                                                        height: 5,
                                                                        background: "var(--ink-4)",
                                                                        borderRadius: 1,
                                                                    }}
                                                                    title={`Default: ${def.fmt(defVal)}`}
                                                                />
                                                                <div
                                                                    style={{
                                                                        position: "absolute",
                                                                        bottom: -14,
                                                                        left: `calc(${defPct}% - 12px)`,
                                                                        width: 26,
                                                                        textAlign: "center",
                                                                        fontFamily: "var(--mono)",
                                                                        fontSize: 7,
                                                                        color: "var(--ink-4)",
                                                                        whiteSpace: "nowrap",
                                                                        pointerEvents: "none",
                                                                    }}
                                                                >
                                                                    ↑ def
                                                                </div>
                                                            </div>
                                                            <div style={{ height: 14 }} />
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        )}
                                    </div>
                                )}

                                <div
                                    style={{
                                        marginTop: 10,
                                        display: "flex",
                                        alignItems: "center",
                                        gap: 8,
                                        flexWrap: "wrap",
                                    }}
                                >
                                    {canOpt ? (
                                        <button
                                            className="btn"
                                            style={{
                                                fontSize: 9,
                                                padding: "3px 9px",
                                                opacity: busy ? 0.5 : 1,
                                            }}
                                            onClick={() => !busy && optimize(agent.id)}
                                            disabled={busy}
                                        >
                                            {busy ? "⟳ …" : "⚡ Optimise"}
                                        </button>
                                    ) : (
                                        <span
                                            style={{
                                                fontFamily: "var(--mono)",
                                                fontSize: 9,
                                                color: "var(--ink-4)",
                                            }}
                                        >
                                            no opt
                                        </span>
                                    )}
                                    {optRes && (
                                        <span
                                            style={{
                                                fontFamily: "var(--mono)",
                                                fontSize: 9,
                                                color: "var(--virtual)",
                                            }}
                                        >
                                            best {AGENT_OPTIMIZE_KEYS[agent.id]?.id}=
                                            {optRes.bestValue} ·{" "}
                                            {(optRes.bestAccuracy * 100).toFixed(0)}% acc
                                        </span>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>
        ))}
    </div>
    );
      };

      // ── ScreenGuide ──────────────────────────────────────────────────────────────
      const ScreenGuide = () => {
        const sections = [
    {
        title: "What is Shoal?",
    body: 'Shoal is an autonomous trading bot that scans a universe of S&P 500 stocks every few seconds. Instead of using a single indicator, it runs 16 specialist AI "agents" simultaneously. Their votes are combined into a weighted consensus — and only when enough agents agree does the bot place a trade.',
          },
    {
        title: "The 16 agents",
    body: "Each agent focuses on one signal type: momentum, mean-reversion, volume, volatility, sentiment, options flow, earnings drift, and more. Agents have different weights — stronger performers are trusted more. Weights update after every closed trade via reinforcement learning.",
          },
    {
        title: "Swarm consensus",
    body: "A trade fires only when the weighted ensemble confidence exceeds the threshold you set in Settings (default 55%). If 10 agents vote BUY and 3 vote SELL, confidence might be 72%. The swarm dashboard shows each agent as a node — green means BUY vote, red means SELL, grey means no opinion. Excluded agents are shown dimmed.",
          },
    {
        title: "Three operating modes",
    items: [
    {
        label: "SIMULATED",
    desc: "Trades are paper-traded locally — no broker connection needed. Best for exploring without an Alpaca account.",
              },
    {
        label: "VIRTUAL",
    desc: "Real orders are sent to your Alpaca paper-trading account. Full broker round-trip, zero real money.",
              },
    {
        label: "LIVE",
    desc: "Real money, real fills through your Alpaca live account. Use with care.",
              },
    ],
          },
    {
        title: "Risk controls",
    body: "The Settings page lets you cap the maximum trade size as a percentage of equity, set a daily loss limit, choose LONG/SHORT/BOTH bias, and raise or lower the confidence threshold. The bot will never place a trade larger than the configured equity percentage, even if it means skipping a ticker entirely.",
          },
    {
        title: "Learning & adaptation",
    body: "After each trade closes, the bot records which agents voted correctly. Over time it shifts weight toward accurate agents and auto-excludes agents that fall below the accuracy threshold (default 35%). Excluded agents are reinstated automatically once their rolling accuracy recovers — you can watch this on the Agent Performance page.",
          },
    {
        title: "Equity curve & backtest",
    body: "The equity curve on the dashboard shows simulated bot performance vs the S&P 500 over the past 180 trading days using real technical signals from the same agents. The Backtest page lets you test four strategies over different periods — it replays PRICE_HISTORY using the same agent ensemble, stochastic exits, and the same risk controls.",
          },
    {
        title: "Fractional shares",
    body: "In VIRTUAL and LIVE modes, orders are sent as notional (dollar) amounts, so the bot can trade any stock regardless of share price. A 5% max trade with $100k equity limits each trade to $5,000 notional — correctly buying 0.26 shares of a $1,900 stock.",
          },
    ];

    return (
    <div className="page" data-screen-label="00 Guide">
        <div className="page-head">
            <div className="page-eyebrow">How it works · Shoal v0.4</div>
            <h1 className="page-title">
                Your field guide to <em>the swarm.</em>
            </h1>
            <p className="page-sub">
                Everything you need to understand what the bot is doing and why
                — from the individual agents all the way to live order
                execution.
            </p>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {sections.map((s, i) => (
                <div key={i} className="card" style={{ padding: "16px 20px" }}>
                    <div
                        style={{
                            display: "flex",
                            gap: 16,
                            alignItems: "flex-start",
                        }}
                    >
                        <div
                            style={{
                                minWidth: 24,
                                height: 24,
                                borderRadius: "50%",
                                background: "var(--virtual)",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                fontFamily: "var(--mono)",
                                fontSize: 10,
                                color: "var(--bg)",
                                fontWeight: 700,
                                marginTop: 2,
                                flexShrink: 0,
                            }}
                        >
                            {i + 1}
                        </div>
                        <div style={{ flex: 1 }}>
                            <div
                                style={{
                                    fontFamily: "var(--mono)",
                                    fontSize: 13,
                                    fontWeight: 600,
                                    color: "var(--ink)",
                                    marginBottom: 6,
                                    letterSpacing: "0.04em",
                                }}
                            >
                                {s.title}
                            </div>
                            {s.body && (
                                <p
                                    style={{
                                        fontFamily: "var(--sans)",
                                        fontSize: 13,
                                        color: "var(--ink-2)",
                                        lineHeight: 1.6,
                                        margin: 0,
                                    }}
                                >
                                    {s.body}
                                </p>
                            )}
                            {s.items && (
                                <div
                                    style={{
                                        display: "flex",
                                        flexDirection: "column",
                                        gap: 8,
                                        marginTop: 4,
                                    }}
                                >
                                    {s.items.map((it, j) => (
                                        <div
                                            key={j}
                                            style={{
                                                display: "flex",
                                                gap: 10,
                                                alignItems: "flex-start",
                                            }}
                                        >
                                            <span
                                                className={
                                                    "pill " +
                                                    (it.label === "LIVE" ? "live" : "virtual")
                                                }
                                                style={{ flexShrink: 0, marginTop: 1 }}
                                            >
                                                {it.label === "LIVE"
                                                    ? "◉ LIVE"
                                                    : it.label === "VIRTUAL"
                                                        ? "◑ VIRTUAL"
                                                        : "◐ SIMULATED"}
                                            </span>
                                            <span
                                                style={{
                                                    fontFamily: "var(--sans)",
                                                    fontSize: 12,
                                                    color: "var(--ink-2)",
                                                    lineHeight: 1.5,
                                                }}
                                            >
                                                {it.desc}
                                            </span>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            ))}
        </div>
    </div>
    );
      };

    const NAV = [
    {id: "dashboard", label: "Dashboard", icon: "dash" },
    {id: "activity", label: "Live activity", icon: "feed" },
    {id: "history", label: "Trade history", icon: "history" },
    {id: "learning", label: "Strategy / learning", icon: "brain" },
    {id: "trade", label: "Trade detail", icon: "trade" },
    {id: "backtest", label: "Backtest", icon: "back" },
    {id: "guide", label: "How it works", icon: "dash" },
    {id: "market", label: "Market map", icon: "market" },
    {id: "agentperf", label: "Agent performance", icon: "perf" },
    {id: "pnltrend", label: "P/L trend", icon: "trend" },
    {id: "sectors", label: "Sector / Universe", icon: "market" },
    {id: "agentconfig", label: "Agent config", icon: "gear" },
    {id: "settings", label: "Settings", icon: "gear" },
    ];

      const App = () => {
        const [mode, setMode] = React.useState(() => {
          const saved = localStorage.getItem("shoal_mode");
    const valid = ["SIMULATED", "VIRTUAL", "LIVE"];
    const savedMode = valid.includes(saved) ? saved : "SIMULATED";
    // If Alpaca is not connected, never restore a broker-dependent mode
    if (savedMode !== "SIMULATED") {
            try {
              const savedAlpaca = JSON.parse(
    localStorage.getItem("shoal_alpaca") || "{ }",
    );
    if (!savedAlpaca.connected) return "SIMULATED";
            } catch (_) {
              return "SIMULATED";
            }
          }
    return savedMode;
        });
    const [route, setRoute] = React.useState(
          () => localStorage.getItem("shoal_route") || "dashboard",
    );
    const [showOnboarding, setShowOnboarding] = React.useState(
          () => !localStorage.getItem("shoal_onboarded"),
    );
    const [running, setRunning] = React.useState(true);
    const [tick, setTick] = React.useState(0);
    const [selectedTrade, setSelectedTrade] = React.useState(null);
    const [pendingMode, setPendingMode] = React.useState(null);
    const [tweaks, setTweaks] = React.useState(TWEAK_DEFAULTS);
    const [editMode, setEditMode] = React.useState(false);
    const [activeSymbol, setActiveSymbol] = React.useState(
          () => localStorage.getItem("shoal_sym") || "NVDA",
    );
    const [direction, setDirection] = React.useState(
          () => localStorage.getItem("shoal_dir") || "BOTH",
    );
    const [symbolPicker, setSymbolPicker] = React.useState(false);
    const [showReset, setShowReset] = React.useState(false);
    const [showWeightReset, setShowWeightReset] = React.useState(false);
        const [tradesResetAt, setTradesResetAt] = React.useState(() => {
          const s = localStorage.getItem("shoal_trades_reset_at");
    return s ? +s : 0;
        });
        // Global trade store — seeded from TRADES (filtered by reset), appended-to by the swarm tick.
        const [trades, setTrades] = React.useState(() => {
          const resetAt = +(localStorage.getItem("shoal_trades_reset_at") || 0);
          return TRADES.filter((t) => t.ts >= resetAt);
        });
        const [balance, setBalance] = React.useState(() => {
          const s = localStorage.getItem("shoal_balance");
    return s ? +s : EQUITY.bot[EQUITY.bot.length - 1];
        });
        const [startingBalance, setStartingBalance] = React.useState(() => {
          const s = localStorage.getItem("shoal_starting_balance");
    return s ? +s : EQUITY.bot[0];
        });
        const [pnl, setPnl] = React.useState(() => {
          const s = localStorage.getItem("shoal_pnl");
    return s ? +s : EQUITY.bot[EQUITY.bot.length - 1] - EQUITY.bot[0];
        });
        const [alpaca, setAlpaca] = React.useState(() => {
          const saved = localStorage.getItem("shoal_alpaca");
    return saved
    ? JSON.parse(saved)
    : {
        connected: false,
    balance: 0,
    account: null,
    broker: "Alpaca Markets",
              };
        });

    // ==========================================
    //    ALLOCATION OF CONSTANTS IN SETTINGS
    // ==========================================

    const [risk, setRisk] = React.useState({
        perTrade: 1.1,
    maxPos: 20,
    dailyLoss: 3,
    confidence: 55,
    shorts: true,
    ah: false,
    maxTradePct: 10,
    minAgentAccuracy: 35,
    autoDisableAgents: false,
    maxDisagreement: 65,
    maxSectorPct: 40,
    stopLoss: 1.5,
    takeProfit: 8,
    minConsensus: 5,
    maxHoldHours: 48,
        });

    const [blacklistedSymbols, setBlacklistedSymbols] = React.useState(
          () => new Set(),
    );
    const [slippageLog, setSlippageLog] = React.useState([]);

    // Simulation speed multiplier (only affects SIMULATED mode)
    const [simSpeed, setSimSpeed] = React.useState(1);

    // UI state: toasts, theme, sidebar, nav group collapse
    const [toasts, setToasts] = React.useState([]);
    const [themeMode, setThemeMode] = React.useState(
          () => localStorage.getItem("shoal_theme") || "dark",
    );
    const [sidebarOpen, setSidebarOpen] = React.useState(false);
    const [navGroups, setNavGroups] = React.useState({
        workspace: true,
    system: true,
        });

        // Agent learning state
        const [agentWeights, setAgentWeights] = React.useState(() => {
          const total = AGENTS.reduce((s, a) => s + a.weight, 0);
    const w = { };
          AGENTS.forEach((a) => (w[a.id] = a.weight / total));
    return w;
        });
        const [agentHistory, setAgentHistory] = React.useState(() => {
          try {
            return JSON.parse(
    localStorage.getItem("shoal_agent_history_v2") || "{ }",
    );
          } catch (_) {
            return { };
          }
        });
    const [agentAccuracySeries, setAgentAccuracySeries] = React.useState(
    { },
    );
    const [lastSignals, setLastSignals] = React.useState(
          () => SIGNALS_ALL["NVDA"] || null,
    );
    const [swarmFocus, setSwarmFocus] = React.useState(null); // {sym, votes, dir, confidence, ts}
        const [agentParams, setAgentParams] = React.useState(() => {
          try {
            return JSON.parse(
    localStorage.getItem("shoal_agent_params") || "{ }",
    );
          } catch (_) {
            return { };
          }
        });
        React.useEffect(() => {
          try {
        localStorage.setItem(
            "shoal_agent_params",
            JSON.stringify(agentParams),
        );
          } catch (_) { }
        }, [agentParams]);
        const [agentParamPresets, setAgentParamPresets] = React.useState(() => {
          try {
            return JSON.parse(
    localStorage.getItem("shoal_agent_param_presets") || "{ }",
    );
          } catch (_) {
            return { };
          }
        });
        React.useEffect(() => {
          try {
        localStorage.setItem(
            "shoal_agent_param_presets",
            JSON.stringify(agentParamPresets),
        );
          } catch (_) { }
        }, [agentParamPresets]);
    const [enabledAgents, setEnabledAgents] = React.useState(
          () => new Set(AGENTS.map((a) => a.id)),
    );
        const [confHistory, setConfHistory] = React.useState(() => [
    ...CONFIDENCE_HISTORY,
    ]);
        const [weightHistory, setWeightHistory] = React.useState(() => {
          try {
            const stored = JSON.parse(
    localStorage.getItem("shoal_weight_history_v2") || "null",
    );
    if (stored && typeof stored === "object") return stored;
          } catch (_) { }
    return { };
        });
    const agentWeightsRef = React.useRef(agentWeights);
    const agentHistoryRef = React.useRef(agentHistory);
    const enabledAgentsRef = React.useRef(enabledAgents);
    const riskRef = React.useRef(risk);
    const tradesRef = React.useRef(trades);
    const activeSymbolRef = React.useRef(activeSymbol);
    const blacklistedSymbolsRef = React.useRef(blacklistedSymbols);
    const balanceRef = React.useRef(balance);
    const startingBalanceRef = React.useRef(startingBalance);
    // Advances through PRICE_HISTORY so rolling vol varies trade-to-trade rather than
    // being frozen at the static tail of the generated series.
    const swarmStepRef = React.useRef(20);
        React.useEffect(() => {
        startingBalanceRef.current = startingBalance;
        }, [startingBalance]);
        React.useEffect(() => {
        agentWeightsRef.current = agentWeights;
        }, [agentWeights]);
        React.useEffect(() => {
        agentHistoryRef.current = agentHistory;
        }, [agentHistory]);
        React.useEffect(() => {
        riskRef.current = risk;
        }, [risk]);
        React.useEffect(() => {
        enabledAgentsRef.current = enabledAgents;
        }, [enabledAgents]);
        React.useEffect(() => {
        tradesRef.current = trades;
        }, [trades]);
        React.useEffect(() => {
        activeSymbolRef.current = activeSymbol;
        }, [activeSymbol]);
        React.useEffect(() => {
        blacklistedSymbolsRef.current = blacklistedSymbols;
        }, [blacklistedSymbols]);
        React.useEffect(() => {
        balanceRef.current = balance;
        }, [balance]);

    // Declared here so the lastSignals effect below (which depends on liveSignals) doesn't hit TDZ
    const [liveSignals, setLiveSignals] = React.useState(null);
    const [livePrices, setLivePrices] = React.useState({ });

        // Keep lastSignals in sync with active symbol and agentParams; prefer live signals when available
        React.useEffect(() => {
        setLastSignals(
            (liveSignals || {})[activeSymbol] ||
            computeSignals(activeSymbol, PRICE_HISTORY, agentParams) ||
            SIGNALS_ALL[activeSymbol] ||
            null,
        );
        }, [activeSymbol, agentParams, liveSignals]);

    // Watch for newly closed trades → update agent weights + accuracy history + accuracy series
    const prevTradesRef = React.useRef([]);
        React.useEffect(() => {
          const prevIds = new Set(
            prevTradesRef.current.filter((t) => t.pnl != null).map((t) => t.id),
    );
    const newlyClosed = trades.filter(
            (t) => t.pnl != null && t.votes && !prevIds.has(t.id),
    );
          if (newlyClosed.length > 0) {
            const newHistory = newlyClosed.reduce(
              (acc, t) => updateAgentHistory(acc, t),
    agentHistoryRef.current,
    );
    const newWeights = newlyClosed.reduce(
    updateAgentWeights,
    agentWeightsRef.current,
    );
    setAgentWeights(newWeights);
    setAgentHistory(newHistory);
            // Append one accuracy data-point per agent for every batch of closes (keeps series lengths in sync)
            setAgentAccuracySeries((series) => {
              const next = {...series};
    for (const a of AGENTS) {
                const hist = newHistory[a.id] || [];
    const acc =
                  hist.length >= 2
    ? hist.filter(Boolean).length / hist.length
    : a.accuracy;
    next[a.id] = [...(next[a.id] || []), acc];
              }
    return next;
            });
            // Append a snapshot of post-update weights to the rolling weight history (cap 90).
            // This makes the "90-day" weight chart actually evolve as the swarm learns.
            setWeightHistory((prev) => {
              const next = {...prev};
    for (const a of AGENTS) {
                const series = next[a.id] || [];
    next[a.id] = [...series, newWeights[a.id] ?? a.weight].slice(
    -90,
    );
              }
    return next;
            });
          }
    prevTradesRef.current = trades;
        }, [trades]);

    // Backend availability (null = checking, true = online, false = offline)
    const [backendOk, setBackendOk] = React.useState(null);

        const [marketStatus, setMarketStatus] = React.useState(() =>
    getMarketStatus(),
    );
    const [streamRetry, setStreamRetry] = React.useState(0);
        React.useEffect(() => {
        setMarketStatus(getMarketStatus());
    const id = setInterval(
            () => setMarketStatus(getMarketStatus()),
    30000,
    );
          return () => clearInterval(id);
        }, []);

    // Stable ref so interval callbacks can read latest alpaca without re-subscribing
    const alpacaRef = React.useRef(alpaca);
        React.useEffect(() => {
        alpacaRef.current = alpaca;
        }, [alpaca]);

    // Stable ref so swarm closure can read latest Alpaca-authoritative market status
    const marketStatusRef = React.useRef(marketStatus);
        React.useEffect(() => {
        marketStatusRef.current = marketStatus;
        }, [marketStatus]);

        // Live signals + prices computed from real Alpaca daily bars.
        // null / { } when disconnected — swarm falls back to static SIGNALS_ALL / tk.last.
    const liveSignalsRef = React.useRef(null);
    const livePricesRef = React.useRef({ });
        React.useEffect(() => {
        liveSignalsRef.current = liveSignals;
        }, [liveSignals]);
        React.useEffect(() => {
        livePricesRef.current = livePrices;
        }, [livePrices]);

        // Fetch 252 daily bars for all tickers when connected; recompute signals from real prices.
        React.useEffect(() => {
          if (!alpaca.connected || !alpaca.token) {
        setLiveSignals(null);
    setLivePrices({ });
    return;
          }
          const symbols = TICKERS.map((t) => t.sym).join(",");
          const fetchBars = async () => {
            try {
              const r = await fetch(
    `${BACKEND_URL}/api/bars?symbols=${encodeURIComponent(symbols)}`,
    {
        headers: {Authorization: "Bearer " + alpaca.token },
    signal: AbortSignal.timeout(15000),
                },
    );
    if (!r.ok) return;
    const data = await r.json();
    if (!data.bars) return;
    // Extract close prices and build a price-history object keyed by symbol
    const priceHistory = { };
    const prices = { };
    for (const sym of Object.keys(data.bars)) {
                const closes = data.bars[sym]
                  .map((b) => b.c)
                  .filter((c) => c > 0);
                if (closes.length >= 60) {
        priceHistory[sym] = closes;
    prices[sym] = closes[closes.length - 1];
                }
              }
    // Recompute all 16-agent signals from real prices (cross-ticker agents use priceHistory too)
    const sigs = { };
    for (const tk of TICKERS) {
                if (!priceHistory[tk.sym]) continue;
    const s = computeSignals(tk.sym, priceHistory);
    if (s) sigs[tk.sym] = s;
              }
              if (Object.keys(sigs).length > 0) {
        setLiveSignals(sigs);
    setLivePrices(prices);
              }
            } catch (_) { }
          };
    fetchBars();
    const id = setInterval(fetchBars, 10 * 60 * 1000); // refresh every 10 min
          return () => clearInterval(id);
        }, [alpaca.connected, alpaca.token]);

        // Backend health-check — polls every 15 s
        React.useEffect(() => {
          const check = async () => {
            try {
              const r = await fetch(`${BACKEND_URL}/api/health`, {
        signal: AbortSignal.timeout(2000),
              });
    setBackendOk(r.ok);
            } catch {
        setBackendOk(false);
            }
          };
    check();
    const hcIvl = setInterval(check, 15000);
          return () => clearInterval(hcIvl);
        }, []);

    // SSE bridge — when Alpaca is connected via the backend, replace simulated data with real fills.
    // Token passed as ?token= because EventSource does not support custom headers.
    const streamRef = React.useRef(null);
        React.useEffect(() => {
          if (!alpaca.connected || !alpaca.token) {
            if (streamRef.current) {
        streamRef.current.close();
    streamRef.current = null;
            }
    return;
          }
    const es = new EventSource(
    `${BACKEND_URL}/api/stream?token=${encodeURIComponent(alpaca.token)}`,
    );
    streamRef.current = es;
          es.onmessage = (e) => {
            try {
              const {account, positions, orders, clock, error} = JSON.parse(
    e.data,
    );
    if (error) return;

    if (clock) {
        setMarketStatus((s) => ({
            ...s,
            isOpen: clock.is_open,
            nextOpen: clock.next_open
                ? new Date(clock.next_open)
                : s.nextOpen,
            source: "alpaca",
        }));
              }

    // Real account equity → replace simulated balance
    if (account?.equity) {
                const eq = parseFloat(account.equity);
                if (eq > 0) setBalance(eq);
              }
    if (account?.buying_power) {
        setAlpaca((a) => ({
            ...a,
            balance: parseFloat(account.buying_power),
        }));
              }

    // Real orders → replace trade list only in LIVE mode (paper env keeps local swarm fills)
    const isLiveEnv = alpacaRef.current?.env === "live";
              if (isLiveEnv && Array.isArray(orders) && orders.length > 0) {
                const mapped = orders.map((o) => ({
        id: o.id,
    ts: new Date(o.submitted_at || o.created_at).getTime(),
    exitTs: o.filled_at ? new Date(o.filled_at).getTime() : null,
    sym: o.symbol,
    side: o.side === "buy" ? "BUY" : "SELL",
    // Parse first then OR — filled_qty is "0" (truthy string) for unfilled orders
    qty: parseFloat(o.filled_qty) || parseFloat(o.qty) || 0,
    // filled_avg_price is null for market orders that haven't filled yet
    price:
    parseFloat(o.filled_avg_price) ||
    parseFloat(o.limit_price) ||
    0,
    exit:
    o.filled_at && o.filled_avg_price
    ? parseFloat(o.filled_avg_price)
    : null,
    conf: 0.75,
    reason: `${o.type || "market"} · ${o.time_in_force} · ${o.status} via Alpaca`,
    pnl: null,
    pnlPct: null,
    status: ["filled", "partially_filled"].includes(o.status)
    ? "OPEN"
    : ["canceled", "expired", "replaced", "rejected"].includes(
    o.status,
    )
    ? "LOSS"
    : "OPEN",
    mode: "LIVE",
    consensus: 12,
    isNew: false,
    _real: true,
                }));
    setTrades(mapped.slice(0, 5000));
              }

              // Real positions → merge with local fills in VIRTUAL mode; replace in LIVE mode
              if (Array.isArray(positions) && positions.length > 0) {
                const realPos = positions.map((p) => ({
        id: "POS-" + p.symbol,
    ts: Date.now() - 7200000,
    exitTs: null,
    sym: p.symbol,
                  side: parseFloat(p.qty) >= 0 ? "BUY" : "SELL",
    qty: Math.abs(parseFloat(p.qty)),
    price: parseFloat(p.avg_entry_price),
    exit: null,
    conf: 0.75,
    reason: `Live position · ${p.side} · unrealized ${parseFloat(p.unrealized_plpc || 0) >= 0 ? "+" : ""}${(parseFloat(p.unrealized_plpc || 0) * 100).toFixed(2)}%`,
    pnl: null,
    pnlPct: null,
    status: "OPEN",
    mode: isLiveEnv ? "LIVE" : "VIRTUAL",
    consensus: 12,
    isNew: false,
    _real: true,
    _upnl: parseFloat(p.unrealized_pl || 0),
    _upnlPct: parseFloat(p.unrealized_plpc || 0),
                }));
                setTrades((prev) => {
                  if (isLiveEnv) {
                    const closedHistory = prev.filter(
                      (t) => t._real && t.status !== "OPEN",
    );
    return [...realPos, ...closedHistory].slice(0, 5000);
                  }
                  // VIRTUAL: keep all local swarm fills; just merge in real positions without wiping
                  const localFills = prev.filter((t) => !t._real);
    const closedReal = prev.filter(
                    (t) => t._real && t.status !== "OPEN",
    );
    return [...realPos, ...localFills, ...closedReal].slice(
    0,
    5000,
    );
                });
    if (account?.portfolio_value)
    setBalance(parseFloat(account.portfolio_value));
              }
            } catch (_) { }
          };
    let _errFired = false;
          es.onerror = () => {
            if (_errFired) return;
    _errFired = true;
    es.close();
    streamRef.current = null;
            setTimeout(() => setStreamRetry((n) => n + 1), 5000);
          };
          return () => {
        es.close();
    streamRef.current = null;
          };
        }, [alpaca.connected, alpaca.token, streamRetry]);

        React.useEffect(() => {
        localStorage.setItem(
            "shoal_agent_history_v2",
            JSON.stringify(agentHistory),
        );
        }, [agentHistory]);
        React.useEffect(() => {
        localStorage.setItem(
            "shoal_weight_history_v2",
            JSON.stringify(weightHistory),
        );
        }, [weightHistory]);
        React.useEffect(() => {
        localStorage.setItem("shoal_sym", activeSymbol);
        }, [activeSymbol]);
        React.useEffect(() => {
        localStorage.setItem("shoal_dir", direction);
        }, [direction]);
        React.useEffect(() => {
        localStorage.setItem("shoal_balance", balance);
        }, [balance]);
        React.useEffect(() => {
        localStorage.setItem("shoal_starting_balance", startingBalance);
        }, [startingBalance]);
        React.useEffect(() => {
        localStorage.setItem("shoal_pnl", pnl);
        }, [pnl]);
        React.useEffect(() => {
        localStorage.setItem("shoal_trades_reset_at", tradesResetAt);
        }, [tradesResetAt]);

        React.useEffect(() => {
          const h = (e) => {
            if (
    e.key === "/" &&
    !["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)
    ) {
        e.preventDefault();
    setSymbolPicker(true);
            }
    if (e.key === "Escape") {
        setSymbolPicker(false);
            }
          };
    window.addEventListener("keydown", h);
          return () => window.removeEventListener("keydown", h);
        }, []);

        const resetAccount = (startingBal) => {
        setBalance(startingBal);
    setStartingBalance(startingBal);
    setPnl(0);
    const now = Date.now();
    setTradesResetAt(now);
    setTrades([]);
    setShowReset(false);
        };

        const resetWeights = () => {
          const total = AGENTS.reduce((s, a) => s + a.weight, 0);
    const defaults = { };
          AGENTS.forEach((a) => (defaults[a.id] = a.weight / total));
    setAgentWeights(defaults);
    setAgentHistory({ });
    setAgentAccuracySeries({ });
    setWeightHistory({ });
    localStorage.removeItem("shoal_agent_history_v2");
    localStorage.removeItem("shoal_weight_history_v2");
    setShowWeightReset(false);
        };

        const exportWeights = () => {
          const csv = serializeWeightsCSV(AGENTS, agentWeights, agentHistory);
    const blob = new Blob([csv], {type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `shoal_weights_${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
        };

        const importWeights = (csvText) => {
          const addToast = (type, text) => {
            const t = {id: Date.now(), type, sym: "CSV", text };
            setToasts((prev) => [...prev.slice(-4), t]);
    setTimeout(
              () => setToasts((prev) => prev.filter((x) => x.id !== t.id)),
    4500,
    );
          };
    try {
            const {weights, history} = parseWeightsCSV(csvText, AGENTS);
    const imported = Object.keys(weights).length;
    if (imported === 0)
    throw new Error("No valid agent rows found in file");
    // Merge imported over current, then re-normalise across all agents
    const merged = {...agentWeights, ...weights };
            const sum = Object.values(merged).reduce((s, v) => s + v, 0);
            if (sum > 0)
              AGENTS.forEach((a) => {
        merged[a.id] = (merged[a.id] || 0) / sum;
              });
    setAgentWeights(merged);
            setAgentHistory((h) => ({...h, ...history }));
    setAgentAccuracySeries({ });
    addToast(
    "close-win",
    `Imported weights for ${imported} agent${imported !== 1 ? "s" : ""}`,
    );
          } catch (err) {
        addToast("close-loss", "Import failed: " + err.message);
          }
        };

        // Global swarm execution — signal-driven trades with real TA, regardless of which screen is mounted.
        React.useEffect(() => {
          if (!running) return;
    const ivl = setInterval(
            () => {
        // Advance the price-history window so vol readings vary trade-to-trade
        swarmStepRef.current = (swarmStepRef.current + 1) % 756;
    const alpacaNow = alpacaRef.current;
    const isLiveReal =
    mode === "LIVE" &&
    !!alpacaNow?.token &&
    alpacaNow?.env === "live";
    const isBrokerPaper =
    mode === "VIRTUAL" &&
    !!alpacaNow?.token &&
    alpacaNow?.env === "paper";
    if (isBrokerPaper)
    console.debug(
    "[Shoal] tick: broker-paper mode active, token OK",
    );

    const riskNow = riskRef.current || { };

    // [4] Stop-loss, take-profit, and time-stop — close non-real positions that hit exit conditions.
    // Uses a deterministic simulated mark derived from each trade's entry price and time elapsed,
    // so the same tick always evaluates to the same mark for the same trade.
    const stopLossPct = (riskNow.stopLoss ?? 2.5) / 100;
    const takeProfitPct = (riskNow.takeProfit ?? 5.0) / 100;
    const maxHoldMs = (riskNow.maxHoldHours ?? 48) * 3600_000;

    const closedSyms = new Set();
              setTrades((prev) => {
                return prev.map((t) => {
                  if (t.status !== "OPEN" || t._real) return t;

    const elapsedMs = Date.now() - t.ts;
    // Signal-correlated mark price: replay PRICE_HISTORY from the entry step so that
    // agents that correctly read the price trend are rewarded with aligned mark moves.
    let markPct;
    const ph = PRICE_HISTORY[t.sym];
    const entryStep = t._phIdx;
    if (ph && entryStep != null) {
                    const curStep = swarmStepRef.current;
    const stepsElapsed =
                      curStep >= entryStep
    ? curStep - entryStep
    : 756 - entryStep + curStep;
    const lookupIdx = Math.min(
    ph.length - 1,
    entryStep + stepsElapsed,
    );
    const phEntry = ph[entryStep];
    markPct =
                      phEntry > 0 ? (ph[lookupIdx] - phEntry) / phEntry : 0;
                  } else {
                    const symSeed = t.sym
    .split("")
                      .reduce((s, c) => s + c.charCodeAt(0), 0);
    const drift =
    Math.sin(symSeed * 0.07 + elapsedMs * 0.000002) * 0.055;
    const elapsedH = elapsedMs / 3600000;
    markPct =
    drift +
    Math.sin(elapsedH * 1.7 + symSeed * 0.031) * 0.025;
                  }
    const upnlPct = markPct * (t.side === "BUY" ? 1 : -1); // from trade's perspective

                  // [6] Max holding period: time-stop — close at near-breakeven after maxHoldHours
                  if (elapsedMs > maxHoldMs) {
                    const pnlAmt = upnlPct * 0.3 * t.qty * t.price; // slight haircut at time-stop
    const exit =
    t.price *
    (1 + markPct * 0.3 * (t.side === "BUY" ? 1 : -1));
    if (t._brokerSent) closedSyms.add(t.sym);
    return {
        ...t,
        status: pnlAmt > 0 ? "WIN" : "LOSS",
    pnl: pnlAmt,
    pnlPct: pnlAmt / (t.qty * t.price),
    exit,
    exitTs: Date.now(),
    isNew: false,
    closeReason: "TIME-STOP",
                    };
                  }
    // [3] Stop-loss: force close if down more than stopLoss%
    if (upnlPct <= -stopLossPct) {
                    const pnlAmt = -stopLossPct * t.qty * t.price;
    const exit =
    t.price * (1 - stopLossPct * (t.side === "BUY" ? 1 : -1));
    if (t._brokerSent) closedSyms.add(t.sym);
    return {
        ...t,
        status: "LOSS",
    pnl: pnlAmt,
    pnlPct: -stopLossPct,
    exit,
    exitTs: Date.now(),
    isNew: false,
    closeReason: "STOP-LOSS",
                    };
                  }
                  // [5] Take-profit: lock in gain if up more than takeProfit%
                  if (upnlPct >= takeProfitPct) {
                    const pnlAmt = takeProfitPct * t.qty * t.price;
    const exit =
    t.price *
    (1 + takeProfitPct * (t.side === "BUY" ? 1 : -1));
    if (t._brokerSent) closedSyms.add(t.sym);
    return {
        ...t,
        status: "WIN",
    pnl: pnlAmt,
    pnlPct: takeProfitPct,
    exit,
    exitTs: Date.now(),
    isNew: false,
    closeReason: "TAKE-PROFIT",
                    };
                  }
    return t;
                });
              });
    if (
    (isLiveReal || isBrokerPaper) &&
    alpacaNow?.token &&
    closedSyms.size
    ) {
        closedSyms.forEach((sym) => {
            fetch(`${BACKEND_URL}/api/positions/${sym}`, {
                method: "DELETE",
                headers: { Authorization: "Bearer " + alpacaNow.token },
            }).catch(() => { });
        });
              }

    const hist = agentHistoryRef.current;
    const minAccuracy = (riskNow.minAgentAccuracy ?? 35) / 100;
    const autoDisableOn = riskNow.autoDisableAgents !== false;

    // Cache decay-weighted accuracy once per tick — reused by dynamicEnabled and Kelly sizing
    const accCache = new Map(
                AGENTS.map((a) => [a.id, decayAccuracy(hist[a.id])]),
    );

    const dynamicEnabled = new Set(
                [...enabledAgentsRef.current].filter((id) => {
                  if (!autoDisableOn) return true;
    const h = hist[id];
    if (!h || h.length < 5) return true;
    const acc = accCache.get(id);
                  return acc === null || acc >= minAccuracy;
                }),
    );

    // Confidence history — always runs every tick so the chart reflects live universe confidence
    {
                const shuffled = TICKERS.slice();
                for (let i = shuffled.length - 1; i > 0; i--) {
                  const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
                }
    const sample = shuffled.slice(0, Math.min(12, shuffled.length));
    let confSum = 0,
    confCnt = 0;
    for (const tk2 of sample) {
                  const s2 = (liveSignalsRef.current || SIGNALS_ALL)[tk2.sym];
    if (!s2 || !Object.keys(s2).length) continue;
    confSum += computeEnsemble(
    s2,
    agentWeightsRef.current,
    dynamicEnabled,
    ).confidence;
    confCnt++;
                }
                if (confCnt > 0)
                  setConfHistory((prev) => [
    ...prev.slice(-89),
    +(confSum / confCnt).toFixed(3),
    ]);
              }

    // Broker connected + market closed: pause new trades entirely (no simulated fallback).
    // Real signals are still computed, but execution waits for the next session open.
    const mktNowGate = marketStatusRef.current;
    if (
    (isLiveReal || isBrokerPaper) &&
    mktNowGate &&
    !mktNowGate.isOpen
    )
    return;

    if (Math.random() < 0.55) {
                const maxDisagree = (riskNow.maxDisagreement ?? 65) / 100;
    const maxSectPct = (riskNow.maxSectorPct ?? 40) / 100;
    const minConf = (riskNow.confidence ?? 55) / 100;
    const minCons = riskNow.minConsensus ?? 5;
    const blacklist = blacklistedSymbolsRef.current;

    // Guard rail: never place a new trade if the account would be wiped.
    // Skip the entire scan if free cash (balance − open exposure) is below
    // a minimum threshold, or below the new trade's notional.
    const balanceNow = balanceRef.current ?? 0;
    const maxVal = (balanceNow * (riskNow.maxTradePct ?? 5)) / 100;
    const openExposure = tradesRef.current
                  .filter((t) => t.status === "OPEN")
                  .reduce((s, t) => s + t.qty * t.price, 0);
    const freeCash = balanceNow - openExposure;
    if (balanceNow <= 100 || freeCash <= 0) return;

    // [8] Half-Kelly sizing from cached decay-weighted accuracy
    // Uses correct asymmetric Kelly: f* = (p*TP - q*SL) / (TP*SL)
    const avgWinRate =
    AGENTS.reduce(
                    (s, a) => s + (accCache.get(a.id) ?? a.accuracy),
    0,
    ) / AGENTS.length;
    const sl = riskNow.stopLoss ?? 2.5,
    tp = riskNow.takeProfit ?? 5.0;
    const fullKelly =
    (avgWinRate * tp - (1 - avgWinRate) * sl) / (tp * sl);
    const kellyFrac = Math.max(0.15, Math.min(0.5, fullKelly / 2));

    // Snapshot current open-position sector concentrations
    const openTrades = tradesRef.current.filter(
                  (t) => t.status === "OPEN",
    );
    const sectorCounts = { };
                openTrades.forEach((t) => {
                  const sect =
                    (TICKERS.find((tk) => tk.sym === t.sym) || { }).sector ||
    "Other";
    sectorCounts[sect] = (sectorCounts[sect] || 0) + 1;
                });
    const totalOpen = openTrades.length;
    const maxPos = riskNow.maxPos ?? 50;

                if (totalOpen >= maxPos) return;

    // [10] Per-ticker win rate — O(N) with Map grouping, computed only when a trade will be attempted
    const allClosed = tradesRef.current.filter(
                  (t) => t.pnl != null,
    );
    const byTicker = new Map();
    for (const t of allClosed) {
                  const arr = byTicker.get(t.sym);
    if (arr) arr.push(t);
    else byTicker.set(t.sym, [t]);
                }
    const tickerEdge = { };
                TICKERS.forEach((tk) => {
                  const recent = (byTicker.get(tk.sym) || []).slice(-10);
                  if (recent.length >= 3)
    tickerEdge[tk.sym] =
                      recent.filter((t) => t.pnl > 0).length / recent.length;
                });

                const openSyms = new Set(openTrades.map((t) => t.sym));
    const signalSource = liveSignalsRef.current || SIGNALS_ALL;
    const candidates = [];
    let scanBest = null;
    for (const tk of TICKERS) {
                  if (blacklist.has(tk.sym)) continue;
    if (openSyms.has(tk.sym)) continue;
    const sigs = signalSource[tk.sym];
    if (!sigs) continue;
    const ens = computeEnsemble(
    sigs,
    agentWeightsRef.current,
    dynamicEnabled,
    );
                  if (!scanBest || ens.confidence > scanBest.ens.confidence)
    scanBest = {tk, sigs, ens};
    // [1] Confidence gate
    if (ens.confidence < minConf) continue;
    // [2] Minimum consensus gate (N agents must agree on direction)
    if (ens.consensus < minCons) continue;
    if (ens.dir === "SELL" && !(riskNow.shorts ?? true)) continue;
                  if (ens.disagreement > maxDisagree) continue;
    // [7] Volatility regime filter — skip extreme outliers only
    // Use a rolling window anchored to swarmStepRef so vol varies each tick
    // rather than always reading the static tail of PRICE_HISTORY.
    const ph = PRICE_HISTORY[tk.sym] || [];
    const wEnd = Math.min(
    ph.length - 1,
    swarmStepRef.current + 20,
    );
    const tkVol = rollingVol(
    ph.slice(Math.max(0, wEnd - 11), wEnd + 1),
    );
                  if (tkVol > 0.25) continue; // filter only genuine high-vol outliers in the generator's distribution
                  if (totalOpen >= 1) {
                    const sect = tk.sector || "Other";
    const sectFrac =
    ((sectorCounts[sect] || 0) + 1) / (totalOpen + 1);
                    if (sectFrac > maxSectPct) continue;
                  }
    if (!ens.dir) continue;
    let side;
    if (direction === "LONG") {
                    if (ens.dir !== "BUY") continue;
    side = "BUY";
                  } else if (direction === "SHORT") {
                    if (ens.dir !== "SELL") continue;
    side = "SELL";
                  } else {
        side = ens.dir;
                  }
    candidates.push({tk, sigs, ens, side, tkVol});
                }

    if (candidates.length === 0 && scanBest) {
        setSwarmFocus({
            sym: scanBest.tk.sym,
            votes: scanBest.ens.votes,
            dir: scanBest.ens.dir,
            confidence: scanBest.ens.confidence,
            ts: Date.now(),
        });
                }

                if (candidates.length > 0) {
                  // Pick up to 3 trades per tick via weighted sampling without replacement
                  const maxPerTick = Math.min(3, candidates.length);
    const pool = [...candidates];
    let cashLeft = freeCash;
    const batchTrades = [];

    for (
    let pick = 0;
    pick < maxPerTick && cashLeft > 1;
    pick++
    ) {
                    const totalScore = pool.reduce((s, c) => {
                      const edge = tickerEdge[c.tk.sym] ?? 0.5;
    return s + c.ens.confidence ** 2 * (0.6 + edge * 0.8);
                    }, 0);
    if (totalScore <= 0) break;

    let rand = Math.random() * totalScore;
    let chosenIdx = 0;
    for (let ci = 0; ci < pool.length; ci++) {
                      const edge = tickerEdge[pool[ci].tk.sym] ?? 0.5;
    rand -= pool[ci].ens.confidence ** 2 * (0.6 + edge * 0.8);
    if (rand <= 0) {
        chosenIdx = ci;
    break;
                      }
                    }

    const chosen = pool.splice(chosenIdx, 1)[0];
    const {tk, sigs, ens: ensemble, side, tkVol } = chosen;
    if (pick === 0)
    setSwarmFocus({
        sym: tk.sym,
    votes: ensemble.votes,
    dir: ensemble.dir,
    confidence: ensemble.confidence,
    ts: Date.now(),
                      });

    const price =
    (livePricesRef.current[tk.sym] || tk.last) *
    (1 + (Math.random() - 0.5) * 0.001);
    const rawNotional =
    maxVal * ensemble.confidence * (0.5 + kellyFrac);
    const notional = parseFloat(
    Math.min(rawNotional, cashLeft).toFixed(2),
    );
    const qty = parseFloat((notional / price).toFixed(4));

    if (notional < 1 || qty < 0.001) continue;
    cashLeft -= notional;

    const voteHistory = Array.from({length: 3 }, (_, i) => {
                      const perturbedSigs = { };
                      AGENTS.forEach((a) => {
                        const s = sigs[a.id];
    if (!s) return;
    const noise = (Math.random() - 0.5) * 0.15 * (3 - i);
    perturbedSigs[a.id] = {
        ...s,
        strength: Math.max(
    0,
    Math.min(1, s.strength + noise),
    ),
    dir: Math.random() < 0.05 * (3 - i) ? -s.dir : s.dir,
                        };
                      });
    return computeEnsemble(
    perturbedSigs,
    agentWeightsRef.current,
    dynamicEnabled,
    ).votes;
                    });

    batchTrades.push({
        id: "TX-" + Math.floor(11000 + Math.random() * 9999),
    ts: Date.now() + pick,
    exitTs: null,
    sym: tk.sym,
    side,
    qty,
    price,
    exit: null,
    conf: ensemble.confidence,
    reason: buildReason(sigs, ensemble),
    pnl: null,
    pnlPct: null,
    status: "OPEN",
    mode,
    consensus: ensemble.consensus,
    votes: ensemble.votes,
    signals: sigs,
    disagreement: ensemble.disagreement,
    annVol: tkVol,
    voteHistory,
    isNew: true,
    _notional: notional,
    _phIdx: swarmStepRef.current,
                    });
                  }

                  if (batchTrades.length > 0) {
                    const mktNow = marketStatusRef.current;
    if ((isLiveReal || isBrokerPaper) && mktNow.isOpen) {
                      for (const newTrade of batchTrades) {
                        const alpacaSide =
    newTrade.side === "BUY" ? "buy" : "sell";
    const orderBody = {
        symbol: newTrade.sym,
    notional: String(newTrade._notional),
    side: alpacaSide,
    type: "market",
    time_in_force: "day",
                        };
    console.log("[Shoal] → Alpaca order", orderBody);
    fetch(`${BACKEND_URL}/api/orders`, {
        method: "POST",
    headers: {
        "Content-Type": "application/json",
    Authorization: "Bearer " + alpacaNow.token,
                          },
    body: JSON.stringify(orderBody),
                        })
                          .then(async (r) => {
                            const body = await r.json();
    if (!r.ok) {
                              const errMsg = body.message || `HTTP ${r.status}`;
    console.warn(
    "[Shoal] Alpaca order rejected",
    newTrade.sym,
    errMsg,
    body,
    );
    const errToast = {
        id: Date.now(),
    type: "close-loss",
    sym: newTrade.sym,
    text: "rejected: " + errMsg,
                              };
                              setToasts((prev) => [
    ...prev.slice(-4),
    errToast,
    ]);
    setTimeout(
                                () =>
                                  setToasts((prev) =>
                                    prev.filter((t) => t.id !== errToast.id),
    ),
    5000,
    );
    return;
                            }
    console.log(
    "[Shoal] ✓ Order confirmed",
    body.id,
    body.status,
    body.symbol,
    );
    const filledPrice = parseFloat(
    body.filled_avg_price || 0,
    );
                            if (filledPrice > 0) {
                              const slip =
    (filledPrice - newTrade.price) / newTrade.price;
                              setSlippageLog((prev) => [
    ...prev.slice(-49),
    {
        sym: newTrade.sym,
    side: newTrade.side,
    expected: newTrade.price,
    actual: filledPrice,
    slip,
    ts: Date.now(),
                                },
    ]);
                            }
    if (!isLiveReal) {
        setTrades((prev) =>
            [
                { ...newTrade, _brokerSent: true },
                ...prev,
            ].slice(0, 5000),
        );
                            }
                          })
                          .catch((err) => {
        console.warn(
            "[Shoal] Order fetch error:",
            err.message,
        );
    const errToast = {
        id: Date.now(),
    type: "close-loss",
    sym: newTrade.sym,
    text: "network: " + err.message,
                            };
                            setToasts((prev) => [...prev.slice(-4), errToast]);
    setTimeout(
                              () =>
                                setToasts((prev) =>
                                  prev.filter((t) => t.id !== errToast.id),
    ),
    5000,
    );
                          });
                      }
                    } else if (!(isLiveReal || isBrokerPaper)) {
        setTrades((prev) =>
            [...batchTrades, ...prev].slice(0, 5000),
        );
                    }
                  }
                }
              }
            },
    Math.max(
    35,
    Math.round(3500 / (mode === "SIMULATED" ? simSpeed : 1)),
    ),
    );
          return () => clearInterval(ivl);
        }, [running, mode, direction, risk, simSpeed]);

        // Live equity = startingBalance + Σ realized P&L + Σ unrealized P&L on open positions.
        // Recomputed on every tick so the dashboard equity, P/L trend, and the swarm tick's
        // zero-balance guard all read the same number. Bypassed when an Alpaca account is
        // connected — SSE pushes the real account equity directly via setBalance().
        React.useEffect(() => {
          if (!running) return;
          const recompute = () => {
            if (
    alpacaRef.current?.token &&
    (mode === "LIVE" || mode === "VIRTUAL")
    )
    return;
    const ts = tradesRef.current || [];
    const lp = livePricesRef.current || { };
    let realized = 0,
    unrealized = 0;
    for (const t of ts) {
              if (t.pnl != null) realized += t.pnl;
    else if (t.status === "OPEN") unrealized += unrealizedPnl(t, lp);
            }
    const equity = startingBalanceRef.current + realized + unrealized;
    setBalance(equity);
    setPnl(realized + unrealized);
          };
    recompute();
    const ivl = setInterval(recompute, 800);
          return () => clearInterval(ivl);
        }, [running, mode]);

        // Theme: apply/remove .light class on <html>
        React.useEffect(() => {
          if (themeMode === "light")
        document.documentElement.classList.add("light");
        else document.documentElement.classList.remove("light");
        localStorage.setItem("shoal_theme", themeMode);
        }, [themeMode]);

        // Toast detection: fire on newly opened or newly closed trades
        const prevToastTradesRef = React.useRef([]);
        React.useEffect(() => {
          const prev = prevToastTradesRef.current;
          const prevMap = new Map(prev.map((t) => [t.id, t]));
        const newToasts = [];
          trades.forEach((t) => {
            if (!prevMap.has(t.id)) {
            newToasts.push({
                id: t.id + "-o",
                type: t.side === "BUY" ? "buy" : "sell",
                sym: t.sym,
                text: t.side + " " + t.qty + " @ " + fmtNum(t.price),
            });
            } else {
              const p = prevMap.get(t.id);
        if (
        p.status === "OPEN" &&
        (t.status === "WIN" || t.status === "LOSS")
        ) {
            newToasts.push({
                id: t.id + "-c",
                type: t.status === "WIN" ? "close-win" : "close-loss",
                sym: t.sym,
                text:
                    t.status + " " + (t.pnl >= 0 ? "+" : "") + fmtMoney(t.pnl),
            });
              }
            }
          });
          if (newToasts.length > 0) {
            setToasts((prev) => [...prev, ...newToasts].slice(-5));
            newToasts.forEach((toast) => {
            setTimeout(
                () =>
                    setToasts((prev) => prev.filter((t) => t.id !== toast.id)),
                3200,
            );
            });
          }
        prevToastTradesRef.current = trades;
        }, [trades]);

        React.useEffect(() => {
            localStorage.setItem("shoal_mode", mode);
        }, [mode]);
        // Drop to SIMULATED whenever the broker connection is lost
        React.useEffect(() => {
          if (!alpaca.connected && mode !== "SIMULATED") setMode("SIMULATED");
        }, [alpaca.connected]);
        React.useEffect(() => {
            localStorage.setItem("shoal_route", route);
        }, [route]);
        React.useEffect(() => {
            localStorage.setItem("shoal_alpaca", JSON.stringify(alpaca));
        }, [alpaca]);

        // global tick for animations
        React.useEffect(() => {
          const tickMs = Math.max(
        50,
        Math.round(800 / (mode === "SIMULATED" ? simSpeed : 1)),
        );
          const ivl = setInterval(() => setTick((t) => t + 1), tickMs);
          return () => clearInterval(ivl);
        }, [simSpeed, mode]);

        // edit mode protocol
        React.useEffect(() => {
          const handler = (e) => {
            if (e.data?.type === "__activate_edit_mode") setEditMode(true);
        if (e.data?.type === "__deactivate_edit_mode") setEditMode(false);
          };
        window.addEventListener("message", handler);
        window.parent.postMessage({type: "__edit_mode_available" }, "*");
          return () => window.removeEventListener("message", handler);
        }, []);

        const handleTradeClick = (t) => {
            setSelectedTrade(t);
        setRoute("trade");
        };

        const handleCloseAll = () => {
          const isLiveReal =
        mode === "LIVE" && !!alpaca?.token && alpaca?.env === "live";
        const isBrokerPaper =
        mode === "VIRTUAL" && !!alpaca?.token && alpaca?.env === "paper";
        const openSyms = new Set(
        tradesRef.current
              .filter((t) => t.status === "OPEN")
              .map((t) => t.sym),
        );
          setTrades((prev) =>
            prev.map((t) => {
              if (t.status !== "OPEN" || t._real) return t;
        const exitPrice = livePricesRef.current[t.sym] || t.price;
        const pnlAmt =
        (exitPrice - t.price) * t.qty * (t.side === "BUY" ? 1 : -1);
        return {
            ...t,
            status: pnlAmt > 0 ? "WIN" : "LOSS",
        pnl: pnlAmt,
        pnlPct: pnlAmt / (t.qty * t.price),
        exit: exitPrice,
        exitTs: Date.now(),
        isNew: false,
              };
            }),
        );
        if (isLiveReal || isBrokerPaper) {
            openSyms.forEach((sym) => {
                fetch(`${BACKEND_URL}/api/positions/${sym}`, {
                    method: "DELETE",
                    headers: { Authorization: "Bearer " + alpaca.token },
                }).catch(() => { });
            });
          }
        };

        const requestMode = (m) => {
          if (m === mode) return;
        setPendingMode(m);
        };
        const confirmMode = () => {
            setMode(pendingMode);
        setPendingMode(null);
        };

        if (showOnboarding) {
          return (
        <ScreenOnboarding
            onDone={() => {
                localStorage.setItem("shoal_onboarded", "1");
                setShowOnboarding(false);
            }}
        />
        );
        }

        // Agents excluded from consensus: manually toggled off OR (when auto-disable is on) below accuracy threshold (≥ 5 trades required)
        const dynamicExcluded = React.useMemo(() => {
          const minAcc = (risk.minAgentAccuracy ?? 35) / 100;
        const autoOff = risk.autoDisableAgents === false;
        return new Set(
            AGENTS.filter((a) => {
              if (!enabledAgents.has(a.id)) return true;
        if (autoOff) return false;
        const h = agentHistory[a.id];
        if (!h || h.length < 5) return false;
        const acc = decayAccuracy(h);
        return acc !== null && acc < minAcc;
            }).map((a) => a.id),
        );
        }, [
        enabledAgents,
        agentHistory,
        risk.minAgentAccuracy,
        risk.autoDisableAgents,
        ]);

        // Session P&L: realized closed trades since ET midnight (US market day boundary)
        const sessionPnl = React.useMemo(() => {
          const now = new Date();
        const etNow = new Date(
        now.toLocaleString("en-US", {timeZone: "America/New_York" }),
        );
        const etMidnight = new Date(etNow);
        etMidnight.setHours(0, 0, 0, 0);
        const midnight =
        etMidnight.getTime() + (now.getTime() - etNow.getTime());
        return trades
            .filter((t) => t.pnl != null && (t.exitTs || 0) >= midnight)
            .reduce((s, t) => s + t.pnl, 0);
        }, [trades]);

        // Available balance = equity − notional locked in open positions.
        // This is the free cash the swarm can deploy on the next trade. Matches the
        // free-cash guard inside the swarm tick.
        const openExposure = React.useMemo(
          () =>
        trades
              .filter((t) => t.status === "OPEN")
              .reduce((s, t) => s + t.qty * t.price, 0),
        [trades],
        );
        const availableBalance = Math.max(0, balance - openExposure);

        const alpacaConnected = !!(alpaca?.connected && alpaca?.token);
        const ctx = {
            activeSymbol,
            setActiveSymbol,
            direction,
            balance,
            startingBalance,
            availableBalance,
            openExposure,
            pnl,
            tradesResetAt,
            trades,
            agentWeights,
            agentHistory,
            agentAccuracySeries,
            lastSignals,
            setSelectedTrade,
            risk,
            setRisk,
            marketStatus,
            dynamicExcluded,
            confHistory,
            blacklistedSymbols,
            setBlacklistedSymbols,
            slippageLog,
            liveSignals,
            livePrices,
            handleCloseAll,
            swarmFocus,
            weightHistory,
            setWeightHistory,
            alpacaConnected,
        };
        const screens = {
            guide: <ScreenGuide />,
        dashboard: (
        <ScreenDashboard
            mode={mode}
            tick={tick}
            onTradeClick={handleTradeClick}
            onMode={requestMode}
            ctx={ctx}
        />
        ),
        activity: (
        <ScreenActivity
            mode={mode}
            tick={tick}
            onTradeClick={handleTradeClick}
            running={running}
            ctx={ctx}
        />
        ),
        history: (
        <ScreenHistory
            mode={mode}
            tick={tick}
            onTradeClick={handleTradeClick}
            ctx={ctx}
        />
        ),
        learning: <ScreenLearning mode={mode} ctx={ctx} />,
        trade: (
        <ScreenTrade
            trade={selectedTrade || TRADES[0]}
            onBack={() => setRoute("dashboard")}
            mode={mode}
            ctx={ctx}
        />
        ),
        backtest: <ScreenBacktest mode={mode} ctx={ctx} />,
        market: <ScreenMarket tick={tick} mode={mode} ctx={ctx} />,
        agentperf: <ScreenAgentPerf mode={mode} ctx={ctx} />,
        pnltrend: <ScreenPnlTrend mode={mode} ctx={ctx} />,
        sectors: <ScreenSectorUniverse mode={mode} ctx={ctx} />,
        agentconfig: (
        <ScreenAgentConfig
            agentParams={agentParams}
            setAgentParams={setAgentParams}
            enabledAgents={enabledAgents}
            setEnabledAgents={setEnabledAgents}
            agentWeights={agentWeights}
            agentHistory={agentHistory}
            agentParamPresets={agentParamPresets}
            setAgentParamPresets={setAgentParamPresets}
        />
        ),
        settings: (
        <ScreenSettings
            mode={mode}
            alpaca={alpaca}
            setAlpaca={setAlpaca}
            risk={risk}
            setRisk={setRisk}
            direction={direction}
            setDirection={setDirection}
            onReset={() => setShowReset(true)}
            onResetWeights={() => setShowWeightReset(true)}
            onExportWeights={exportWeights}
            onImportWeights={importWeights}
            backendOk={backendOk}
        />
        ),
        };

        const navItem = NAV.find((n) => n.id === route);
        const navItemLabel = navItem ? navItem.label : "Dashboard";

        const closeNavOnMobile = () => setSidebarOpen(false);

        return (
        <div className={"shell " + (mode === "LIVE" ? "live" : "")}>
            {/* Mobile sidebar backdrop */}
            {sidebarOpen && (
                <div
                    className="sidebar-backdrop"
                    onClick={() => setSidebarOpen(false)}
                />
            )}

            <aside className={"sidebar " + (sidebarOpen ? "mob-open" : "")}>
                <div className="brand">
                    <div className="brand-row">
                        <span className="brand-mark"></span>
                        <span className="brand-name">Shoal</span>
                    </div>
                    <div className="brand-sub">Adaptive · v0.4.2</div>
                </div>

                <div
                    className="mode-pill"
                    onClick={() => {
                        requestMode(
                            mode === "SIMULATED"
                                ? "VIRTUAL"
                                : mode === "VIRTUAL"
                                    ? "LIVE"
                                    : "SIMULATED",
                        );
                        closeNavOnMobile();
                    }}
                >
                    <div className="mode-pill-row">
                        <span className="mode-pill-label">Trading mode</span>
                        <span className="mono tiny muted">↻ cycle</span>
                    </div>
                    <div style={{ marginTop: 6 }}>
                        <span className="mode-dot"></span>
                        <span className="mode-pill-value">
                            {mode === "LIVE"
                                ? "LIVE TRADING"
                                : mode === "VIRTUAL"
                                    ? "VIRTUAL · BROKER"
                                    : "SIMULATED · LOCAL"}
                        </span>
                    </div>
                </div>

                {/* Collapsible workspace group */}
                <div className="nav-section">
                    <div
                        className="nav-group-header"
                        onClick={() =>
                            setNavGroups((g) => ({ ...g, workspace: !g.workspace }))
                        }
                    >
                        <div
                            className="nav-label"
                            style={{ paddingLeft: 0, paddingTop: 0, paddingBottom: 0 }}
                        >
                            Workspace
                        </div>
                        <span
                            className={
                                "nav-chevron " + (navGroups.workspace ? "open" : "")
                            }
                        >
                            ▶
                        </span>
                    </div>
                    {navGroups.workspace &&
                        NAV.slice(0, 7).map((n) => (
                            <div
                                key={n.id}
                                className={"nav-item " + (route === n.id ? "active" : "")}
                                onClick={() => {
                                    setRoute(n.id);
                                    closeNavOnMobile();
                                }}
                            >
                                <span className="nav-icon">
                                    <Icon name={n.icon} />
                                </span>
                                <span>{n.label}</span>
                            </div>
                        ))}
                </div>

                {/* Collapsible system group */}
                <div className="nav-section">
                    <div
                        className="nav-group-header"
                        onClick={() =>
                            setNavGroups((g) => ({ ...g, system: !g.system }))
                        }
                    >
                        <div
                            className="nav-label"
                            style={{ paddingLeft: 0, paddingTop: 0, paddingBottom: 0 }}
                        >
                            System
                        </div>
                        <span
                            className={
                                "nav-chevron " + (navGroups.system ? "open" : "")
                            }
                        >
                            ▶
                        </span>
                    </div>
                    {navGroups.system &&
                        NAV.slice(7).map((n) => (
                            <div
                                key={n.id}
                                className={"nav-item " + (route === n.id ? "active" : "")}
                                onClick={() => {
                                    setRoute(n.id);
                                    closeNavOnMobile();
                                }}
                            >
                                <span className="nav-icon">
                                    <Icon name={n.icon} />
                                </span>
                                <span>{n.label}</span>
                                {n.id === "settings" && !alpaca.connected && (
                                    <span
                                        className="nav-num warn"
                                        style={{ color: "var(--warn)" }}
                                    >
                                        !
                                    </span>
                                )}
                            </div>
                        ))}
                </div>

                <div className="sidebar-foot">
                    <div className="row">
                        <span>Engine</span>
                        <span className="ok">● online</span>
                    </div>
                    <div className="row">
                        <span>Backend</span>
                        <span
                            className={
                                backendOk === true
                                    ? "ok"
                                    : backendOk === false
                                        ? "dn"
                                        : "muted"
                            }
                        >
                            {backendOk === true
                                ? "● online"
                                : backendOk === false
                                    ? "○ offline"
                                    : "○ …"}
                        </span>
                    </div>
                    <div className="row">
                        <span>Broker</span>
                        <span className={alpaca.connected ? "ok" : ""}>
                            {alpaca.connected
                                ? "● Alpaca" + (alpaca.token ? " ⟳" : "")
                                : "○ none"}
                        </span>
                    </div>
                    <div className="row">
                        <span>Market</span>
                        <span
                            className={
                                !alpaca.connected ? "" : marketStatus.isOpen ? "ok" : ""
                            }
                            style={
                                !alpaca.connected
                                    ? { color: "var(--ink-4)" }
                                    : !marketStatus.isOpen
                                        ? { color: "var(--warn)" }
                                        : {}
                            }
                        >
                            {!alpaca.connected
                                ? "— not connected"
                                : marketStatus.isOpen
                                    ? "● open"
                                    : "○ closed"}
                        </span>
                    </div>
                    <div className="row">
                        <span>Latency</span>
                        <span>{42 + (tick % 8)}ms</span>
                    </div>
                    <div
                        className="theme-toggle"
                        onClick={() =>
                            setThemeMode((m) => (m === "dark" ? "light" : "dark"))
                        }
                    >
                        <span>
                            {themeMode === "light" ? "◑ Light mode" : "◐ Dark mode"}
                        </span>
                        <div className="theme-pill" />
                    </div>
                </div>
            </aside>

            <main className="main">
                <div className="topbar">
                    {/* Hamburger — visible only on mobile via CSS */}
                    <button
                        className={"hamburger " + (sidebarOpen ? "open" : "")}
                        onClick={() => setSidebarOpen((o) => !o)}
                        aria-label="Toggle menu"
                    >
                        <span />
                        <span />
                        <span />
                    </button>
                    <div className="crumb">
                        SHOAL / <b>{navItemLabel}</b>
                    </div>
                    <button
                        className="btn"
                        style={{
                            marginLeft: 8,
                            padding: "6px 12px",
                            display: "flex",
                            alignItems: "center",
                            gap: 10,
                        }}
                        onClick={() => setSymbolPicker(true)}
                        title="Switch symbol ( / )"
                    >
                        <span
                            className="mono"
                            style={{
                                color: "var(--ink)",
                                fontWeight: 500,
                                letterSpacing: "0.02em",
                            }}
                        >
                            ◎ {activeSymbol}
                        </span>
                        {alpaca.connected && !marketStatus.isOpen && (
                            <span
                                style={{
                                    fontSize: 9,
                                    letterSpacing: "0.12em",
                                    padding: "2px 6px",
                                    borderRadius: 3,
                                    background: "var(--line-2)",
                                    color: "var(--warn)",
                                    fontFamily: "var(--mono)",
                                    fontWeight: 500,
                                }}
                            >
                                CLOSED
                            </span>
                        )}
                        <span
                            className="mono tiny muted"
                            style={{ letterSpacing: "0.1em" }}
                        >
                            ⌘/
                        </span>
                    </button>
                    <div className="tweak-opts" style={{ marginLeft: 6 }}>
                        {["LONG", "SHORT", "BOTH"].map((d) => (
                            <div
                                key={d}
                                className={"tweak-opt " + (direction === d ? "on" : "")}
                                onClick={() => setDirection(d)}
                                title={
                                    d === "LONG"
                                        ? "Buy-only · no shorting"
                                        : d === "SHORT"
                                            ? "Short-only · contrarian"
                                            : "Both directions"
                                }
                            >
                                {d === "LONG"
                                    ? "↑ LONG"
                                    : d === "SHORT"
                                        ? "↓ SHORT"
                                        : "⇅ BOTH"}
                            </div>
                        ))}
                    </div>
                    <div className="topbar-spacer"></div>
                    {/* Available balance badge */}
                    <div
                        className="session-pnl"
                        style={{
                            color: "var(--ink-2)",
                            background: "var(--bg-2)",
                            cursor: "help",
                        }}
                        title={`Free cash available for new trades.\nEquity ${fmtMoney(balance, 0)} − locked ${fmtMoney(openExposure, 0)} = available ${fmtMoney(availableBalance, 0)}`}
                    >
                        Available {fmtMoney(availableBalance, 0)}
                    </div>
                    {/* Session P&L badge */}
                    <div
                        className={"session-pnl " + (sessionPnl >= 0 ? "up" : "dn")}
                    >
                        Session {sessionPnl >= 0 ? "+" : ""}
                        {fmtMoney(sessionPnl)}
                    </div>
                    {tweaks.animated && (
                        <TickerStrip tickers={TICKERS} tick={tick} />
                    )}
                    {mode === "SIMULATED" && (
                        <div
                            className="tweak-opts"
                            style={{ marginRight: 6 }}
                            title="Simulation speed multiplier"
                        >
                            {[1, 5, 10, 100].map((s) => (
                                <div
                                    key={s}
                                    className={"tweak-opt " + (simSpeed === s ? "on" : "")}
                                    onClick={() => setSimSpeed(s)}
                                >
                                    {s}x
                                </div>
                            ))}
                        </div>
                    )}
                    <div className={"bot-status " + (running ? "" : "paused")}>
                        <span className="led"></span>
                        <span>{running ? "BOT RUNNING" : "BOT PAUSED"}</span>
                        <button onClick={() => setRunning(!running)}>
                            {running ? "PAUSE" : "RESUME"}
                        </button>
                    </div>
                </div>

                <div className="notif-strip">
                    <ToastOverlay
                        toasts={toasts}
                        onRemove={(id) =>
                            setToasts((prev) => prev.filter((t) => t.id !== id))
                        }
                    />
                </div>

                <div className="main-scroll">{screens[route]}</div>
            </main>

            {pendingMode && (
                <ModeSwitchModal
                    targetMode={pendingMode}
                    alpaca={alpaca}
                    onConfirm={confirmMode}
                    onCancel={() => setPendingMode(null)}
                />
            )}
            {symbolPicker && (
                <SymbolPicker
                    onPick={(s) => {
                        setActiveSymbol(s);
                        setSymbolPicker(false);
                    }}
                    onClose={() => setSymbolPicker(false)}
                    marketStatus={marketStatus}
                />
            )}
            {showReset && (
                <ResetModal
                    onConfirm={resetAccount}
                    onCancel={() => setShowReset(false)}
                />
            )}
            {showWeightReset && (
                <WeightResetModal
                    onConfirm={resetWeights}
                    onCancel={() => setShowWeightReset(false)}
                />
            )}
            {editMode && (
                <TweaksPanel
                    tweaks={tweaks}
                    setTweaks={(nt) => {
                        setTweaks(nt);
                        window.parent.postMessage(
                            { type: "__edit_mode_set_keys", edits: nt },
                            "*",
                        );
                    }}
                />
            )}
        </div>
        );
      };

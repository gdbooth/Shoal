// Minimal stand-in for IG's REST API, enough to exercise brokers/ig.js end to end.
import express from 'express';

export const MOCK_API_KEY = 'mock-ig-api-key-0123456789';

export function startMockIG() {
  const app = express();
  app.use(express.json());
  const state = {
    current: 'CFD1',
    positions: [],
    confirms: new Map(),
    confirmMisses: new Map(),
    calls: [],
    seq: 0,
    gen: 1, // bump to expire the issued tokens
  };
  const MARKETS = {
    'UA.D.AAPL.DAILY.IP': { name: 'Apple Inc', bid: 21840, offer: 21844, min: 0.04 },
    'UA.D.MSFT.DAILY.IP': { name: 'Microsoft Corp', bid: 41900, offer: 41910, min: 0.04 },
  };

  const authed = (req, res, next) => {
    state.calls.push(`${req.method} ${req.path} v${req.get('Version')}`);
    if (req.get('X-IG-API-KEY') !== MOCK_API_KEY) return res.status(403).json({ errorCode: 'error.security.invalid-api-key' });
    if (req.path === '/session' && req.method === 'POST') return next();
    if (req.get('CST') !== `cst-${state.gen}` || req.get('X-SECURITY-TOKEN') !== `xst-${state.gen}`) {
      return res.status(401).json({ errorCode: 'error.security.client-token-invalid' });
    }
    next();
  };
  app.use(authed);

  app.post('/session', (req, res) => {
    if (req.get('Version') !== '2') return res.status(400).json({ errorCode: 'wrong version' });
    if (req.body.identifier !== 'user' || req.body.password !== 'pw') return res.status(401).json({ errorCode: 'error.security.invalid-details' });
    res.set('CST', `cst-${state.gen}`).set('X-SECURITY-TOKEN', `xst-${state.gen}`).json({
      currentAccountId: state.current,
      currencyIsoCode: 'GBP',
      lightstreamerEndpoint: null, // no streaming in tests → REST fallback path
      accounts: [
        { accountId: 'CFD1', accountType: 'CFD', preferred: true },
        { accountId: 'SB1',  accountType: 'SPREADBET', preferred: false },
      ],
    });
  });
  app.put('/session', (req, res) => { state.current = req.body.accountId; res.json({}); });
  app.delete('/session', (_req, res) => res.status(204).end());

  app.get('/accounts', (_req, res) => {
    const upl = state.positions.reduce((s, p) => s + (p.direction === 'BUY' ? MARKETS[p.epic].bid - p.level : p.level - MARKETS[p.epic].offer) * p.size, 0);
    res.json({ accounts: [
      { accountId: 'CFD1', accountType: 'CFD', status: 'ENABLED', currency: 'GBP', balance: { balance: 1, deposit: 0, profitLoss: 0, available: 1 } },
      { accountId: 'SB1', accountType: 'SPREADBET', status: 'ENABLED', currency: 'GBP', balance: { balance: 10000, deposit: 500, profitLoss: upl, available: 9500 } },
    ] });
  });

  app.get('/markets', (req, res) => {
    if (req.query.searchTerm) {
      const t = req.query.searchTerm;
      const hits = Object.entries(MARKETS).filter(([e]) => e.split('.').includes(t)).flatMap(([epic, m]) => [
        { epic: epic.replace('DAILY', 'CASH'), instrumentName: m.name, instrumentType: 'SHARES', expiry: '-' },
        { epic, instrumentName: m.name, instrumentType: 'SHARES', expiry: 'DFB' },
      ]);
      return res.json({ markets: hits });
    }
    const epics = String(req.query.epics || '').split(',');
    res.json({ marketDetails: epics.filter(e => MARKETS[e]).map(e => ({
      instrument: { epic: e }, snapshot: { bid: MARKETS[e].bid, offer: MARKETS[e].offer, marketStatus: 'TRADEABLE' },
    })) });
  });
  app.get('/markets/:epic', (req, res) => {
    const m = MARKETS[req.params.epic];
    if (!m) return res.status(404).json({ errorCode: 'error.service.marketdata.instrument.epic.unavailable' });
    res.json({
      instrument: { epic: req.params.epic, currencies: [{ code: 'GBP', isDefault: true }] },
      dealingRules: { minDealSize: { unit: 'POINTS', value: m.min } },
      snapshot: { bid: m.bid, offer: m.offer, marketStatus: 'TRADEABLE' },
    });
  });

  app.get('/positions', (_req, res) => res.json({ positions: state.positions.map(p => ({
    position: { dealId: p.dealId, direction: p.direction, size: p.size, level: p.level, currency: 'GBP' },
    market: { epic: p.epic, bid: MARKETS[p.epic].bid, offer: MARKETS[p.epic].offer },
  })) }));

  app.post('/positions/otc', (req, res) => {
    const ref = `REF${++state.seq}`;
    state.confirmMisses.set(ref, 1); // first confirm call 404s, like IG sometimes does
    if (req.get('_method') === 'DELETE') {
      const p = state.positions.find(x => x.dealId === req.body.dealId);
      state.positions = state.positions.filter(x => x !== p);
      state.confirms.set(ref, { dealReference: ref, dealId: p.dealId, dealStatus: 'ACCEPTED', reason: 'SUCCESS', status: 'CLOSED', level: MARKETS[p.epic].bid, size: p.size });
      return res.json({ dealReference: ref });
    }
    const { epic, direction, size, expiry, orderType, currencyCode } = req.body;
    if (expiry !== 'DFB' || orderType !== 'MARKET' || currencyCode !== 'GBP') return res.status(400).json({ errorCode: 'validation' });
    if (size > 100) {
      state.confirms.set(ref, { dealReference: ref, dealStatus: 'REJECTED', reason: 'INSUFFICIENT_FUNDS' });
      return res.json({ dealReference: ref });
    }
    const dealId = `DEAL${state.seq}`;
    const level = direction === 'BUY' ? MARKETS[epic].offer : MARKETS[epic].bid;
    state.positions.push({ dealId, epic, direction, size, level });
    state.confirms.set(ref, { dealReference: ref, dealId, dealStatus: 'ACCEPTED', reason: 'SUCCESS', status: 'OPEN', level, size, direction, epic });
    res.json({ dealReference: ref });
  });
  app.get('/confirms/:ref', (req, res) => {
    const misses = state.confirmMisses.get(req.params.ref) || 0;
    if (misses > 0) { state.confirmMisses.set(req.params.ref, misses - 1); return res.status(404).json({ errorCode: 'error.confirms.deal-not-found' }); }
    res.json(state.confirms.get(req.params.ref));
  });

  app.get('/prices/:epic', (req, res) => {
    const n = req.query.max ? Number(req.query.max) : 2;
    const base = MARKETS[req.params.epic].bid;
    const prices = Array.from({ length: n }, (_, i) => {
      const d = new Date(Date.UTC(2026, 0, 1) + (i - n + 1) * 86_400_000 + Date.now() - Date.UTC(2026, 0, 1));
      const c = base + i;
      return { snapshotTimeUTC: d.toISOString().slice(0, 10) + 'T00:00:00', closePrice: { bid: c - 1, ask: c + 1 }, openPrice: { bid: c - 1, ask: c + 1 }, highPrice: { bid: c, ask: c + 2 }, lowPrice: { bid: c - 2, ask: c }, lastTradedVolume: 100 };
    });
    res.json({ prices, metadata: { allowance: { remainingAllowance: 9000, totalAllowance: 10000 } } });
  });

  return new Promise(resolve => {
    const srv = app.listen(0, () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}`, state }));
  });
}

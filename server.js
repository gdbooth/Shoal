import express from 'express';
import cors from 'cors';
import { randomBytes } from 'crypto';
import nodeFetch from 'node-fetch';

// Use native fetch (Node 18+) when available, otherwise fall back to node-fetch.
const fetch = globalThis.fetch ?? nodeFetch;

// Surface unhandled rejections instead of letting them silently crash the process.
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
});

const app = express();
app.use(cors());
app.use(express.json());

// In-memory session store: token -> { keyId, secret, env }
// Keys are never written to disk; sessions survive only until the process restarts.
const sessions = new Map();

const BASE = {
  paper: 'https://paper-api.alpaca.markets',
  live:  'https://api.alpaca.markets',
};

function alpacaHeaders(session) {
  return {
    'APCA-API-KEY-ID':     session.keyId,
    'APCA-API-SECRET-KEY': session.secret,
    'Content-Type':        'application/json',
  };
}

// Middleware: validate Bearer token from Authorization header or ?token= query param
function auth(req, res, next) {
  const raw = req.headers.authorization || '';
  const token = raw.startsWith('Bearer ') ? raw.slice(7) : req.query.token;
  const session = token && sessions.get(token);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  req.session = session;
  req.token   = token;
  next();
}

// ── Health check ────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({ ok: true }));

// ── Connect: validate keys against Alpaca, create session ───────────────────
app.post('/api/connect', async (req, res) => {
  const { keyId, secret, env } = req.body || {};
  if (!keyId || !secret || !['paper', 'live'].includes(env)) {
    return res.status(400).json({ error: 'Missing or invalid fields (keyId, secret, env)' });
  }

  const base = BASE[env];
  let accountData;
  try {
    const r = await fetch(`${base}/v2/account`, {
      headers: { 'APCA-API-KEY-ID': keyId, 'APCA-API-SECRET-KEY': secret },
    });
    if (!r.ok) {
      const body = await r.text();
      return res.status(401).json({ error: 'Alpaca rejected these credentials', detail: body });
    }
    accountData = await r.json();
  } catch (err) {
    return res.status(502).json({ error: 'Could not reach Alpaca', detail: err.message });
  }

  const token = randomBytes(28).toString('hex');
  sessions.set(token, { keyId, secret, env });

  res.json({
    token,
    account: {
      id:              accountData.id,
      status:          accountData.status,
      equity:          parseFloat(accountData.equity          || 0),
      buyingPower:     parseFloat(accountData.buying_power    || 0),
      cash:            parseFloat(accountData.cash            || 0),
      portfolioValue:  parseFloat(accountData.portfolio_value || 0),
      patternDayTrader: accountData.pattern_day_trader,
      tradingBlocked:   accountData.trading_blocked,
      daytradingBuyingPower: parseFloat(accountData.daytrading_buying_power || 0),
    },
  });
});

// ── Disconnect: drop session ─────────────────────────────────────────────────
app.delete('/api/disconnect', auth, (req, res) => {
  sessions.delete(req.token);
  res.json({ ok: true });
});

// ── Account ──────────────────────────────────────────────────────────────────
app.get('/api/account', auth, async (req, res) => {
  try {
    const r = await fetch(`${BASE[req.session.env]}/v2/account`, { headers: alpacaHeaders(req.session) });
    res.status(r.status).json(await r.json());
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── Positions ────────────────────────────────────────────────────────────────
app.get('/api/positions', auth, async (req, res) => {
  try {
    const r = await fetch(`${BASE[req.session.env]}/v2/positions`, { headers: alpacaHeaders(req.session) });
    res.status(r.status).json(await r.json());
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── Orders: list ─────────────────────────────────────────────────────────────
app.get('/api/orders', auth, async (req, res) => {
  try {
    const qs = new URLSearchParams({ status: 'all', limit: '100', ...req.query });
    qs.delete('token'); // strip our internal auth param
    const r = await fetch(`${BASE[req.session.env]}/v2/orders?${qs}`, { headers: alpacaHeaders(req.session) });
    res.status(r.status).json(await r.json());
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── Orders: place ────────────────────────────────────────────────────────────
app.post('/api/orders', auth, async (req, res) => {
  try {
    const r = await fetch(`${BASE[req.session.env]}/v2/orders`, {
      method:  'POST',
      headers: alpacaHeaders(req.session),
      body:    JSON.stringify(req.body),
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── Orders: cancel ───────────────────────────────────────────────────────────
app.delete('/api/orders/:id', auth, async (req, res) => {
  try {
    const r = await fetch(`${BASE[req.session.env]}/v2/orders/${req.params.id}`, {
      method:  'DELETE',
      headers: alpacaHeaders(req.session),
    });
    if (r.status === 204) return res.json({ ok: true });
    res.status(r.status).json(await r.json());
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── SSE stream: polls account + positions + orders every 3 s ─────────────────
// Token is read from ?token= because EventSource does not support custom headers.
app.get('/api/stream', auth, (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering if proxied
  res.flushHeaders();

  const { session } = req;

  const push = async () => {
    try {
      const [rAcc, rPos, rOrd, rClk] = await Promise.all([
        fetch(`${BASE[session.env]}/v2/account`,           { headers: alpacaHeaders(session) }),
        fetch(`${BASE[session.env]}/v2/positions`,         { headers: alpacaHeaders(session) }),
        fetch(`${BASE[session.env]}/v2/orders?status=all&limit=50`, { headers: alpacaHeaders(session) }),
        fetch(`${BASE[session.env]}/v2/clock`,             { headers: alpacaHeaders(session) }),
      ]);
      const [account, positions, orders, clock] = await Promise.all([rAcc.json(), rPos.json(), rOrd.json(), rClk.json()]);
      res.write(`data: ${JSON.stringify({ account, positions, orders, clock })}\n\n`);
    } catch (err) {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    }
  };

  push(); // immediate first update
  const interval = setInterval(push, 3000);
  req.on('close', () => clearInterval(interval));
});

const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, () => {
  console.log(`Shoal backend  →  http://localhost:${PORT}`);
  console.log(`Paper API      →  ${BASE.paper}`);
  console.log(`Live API       →  ${BASE.live}`);
  console.log('Sessions are held in memory — no keys written to disk.\n');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nERROR: Port ${PORT} is already in use.`);
    console.error(`Either stop the other process or set a different port:\n  PORT=3002 node server.js\n`);
  } else {
    console.error('\nServer error:', err.message);
  }
  process.exit(1);
});

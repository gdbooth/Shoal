import express from 'express';
import cors from 'cors';
import { randomBytes } from 'crypto';
import { alpaca } from './brokers/alpaca.js';
import { ig } from './brokers/ig.js';

// Surface unhandled rejections instead of letting them silently crash the process.
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
});

const BROKERS = { alpaca, ig };

const app = express();
app.use(cors());
app.use(express.json());

// In-memory session store: token → broker session (holds that broker's credentials).
// Credentials are never written to disk; sessions survive only until the process restarts.
const sessions = new Map();

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

const SYMBOL_RE = /^[A-Za-z0-9.\-]{1,20}$/;

// Wrap a handler that returns { status, body } from a broker session.
const proxy = (fn) => async (req, res) => {
  try {
    const { status, body } = await fn(req);
    res.status(status).json(body);
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message, message: err.message, detail: err.detail });
  }
};

// ── Health check ────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({ ok: true, brokers: Object.keys(BROKERS) }));

// ── Connect: validate credentials with the broker, create session ───────────
// Body: { broker: 'alpaca' | 'ig', env: 'paper' | 'live', ...credentials, symbols? }
//   alpaca: keyId, secret
//   ig:     apiKey, username, password, accountId? ('paper' maps to IG's demo environment)
app.post('/api/connect', async (req, res) => {
  const { broker: brokerId = 'alpaca', symbols, ...creds } = req.body || {};
  const broker = BROKERS[brokerId];
  if (!broker) return res.status(400).json({ error: `Unknown broker "${brokerId}"` });

  const universe = Array.isArray(symbols) ? symbols.filter(s => SYMBOL_RE.test(s)).slice(0, 50) : [];
  try {
    const { session, account } = await broker.connect(creds, { universe });
    const token = randomBytes(28).toString('hex');
    sessions.set(token, session);
    res.json({
      token,
      broker: { id: broker.id, name: broker.name, endpoint: broker.endpoints[creds.env] },
      account,
    });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message, detail: err.detail });
  }
});

// ── Disconnect: drop session ─────────────────────────────────────────────────
app.delete('/api/disconnect', auth, (req, res) => {
  req.session.close();
  sessions.delete(req.token);
  res.json({ ok: true });
});

// ── Account / positions / orders ─────────────────────────────────────────────
app.get('/api/account',   auth, proxy(req => req.session.account()));
app.get('/api/positions', auth, proxy(req => req.session.positions()));

app.get('/api/orders', auth, proxy(req => {
  const { token, ...query } = req.query; // strip our internal auth param
  return req.session.orders(query);
}));

app.post('/api/orders', auth, proxy(req => req.session.placeOrder(req.body)));

// Close (flatten) a symbol position
app.delete('/api/positions/:symbol', auth, proxy(req => {
  if (!SYMBOL_RE.test(req.params.symbol)) return { status: 400, body: { error: 'Invalid symbol' } };
  return req.session.closePosition(req.params.symbol);
}));

app.delete('/api/orders/:id', auth, proxy(req => req.session.cancelOrder(req.params.id)));

// ── Market data: daily bars for live signal computation ───────────────────────
// Returns up to 252 daily closes per symbol so the client can recompute all
// 16 agent signals from real prices instead of the synthetic seed data.
app.get('/api/bars', auth, proxy(req => {
  const symbols = (req.query.symbols || '').split(',').filter(s => SYMBOL_RE.test(s)).slice(0, 30);
  if (!symbols.length) return { status: 400, body: { error: 'symbols required' } };
  return req.session.bars(symbols);
}));

// ── SSE stream: pushes account + positions + orders + clock (+ prices for IG) ─
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
      res.write(`data: ${JSON.stringify(await session.snapshot())}\n\n`);
    } catch (err) {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    }
  };

  push(); // immediate first update
  const interval = setInterval(push, session.streamIntervalMs);
  req.on('close', () => clearInterval(interval));
});

const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, () => {
  console.log(`Shoal backend  →  http://localhost:${PORT}`);
  for (const b of Object.values(BROKERS)) {
    console.log(`${b.name.padEnd(15)}→  paper/demo ${b.endpoints.paper}  ·  live ${b.endpoints.live}`);
  }
  console.log('Sessions are held in memory — no credentials written to disk.\n');
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

export { app, server };

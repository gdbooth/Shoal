import express from 'express';
import cors from 'cors';
import { randomBytes, createHash, createCipheriv, createDecipheriv } from 'crypto';
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

// Serverless hosts (Vercel) don't keep one long-lived process, so an in-memory session can vanish
// between requests. When SHOAL_SESSION_SECRET is set, the token itself carries the credentials,
// encrypted with AES-256-GCM, and any instance can rebuild the session from it. Without the
// secret, tokens are random and sessions live only in this process (the local default).
const SESSION_KEY = process.env.SHOAL_SESSION_SECRET
  ? createHash('sha256').update(process.env.SHOAL_SESSION_SECRET).digest()
  : null;
const SEALED_TTL_MS = 24 * 3600_000;
// Sealed tokens can't be revoked everywhere; this covers the instance that handled the disconnect,
// and the browser discards the token. They expire after SEALED_TTL_MS regardless.
const revoked = new Set();

function seal(payload) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', SESSION_KEY, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(payload)), c.final()]);
  return 's1.' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
}

function unseal(token) {
  if (!SESSION_KEY || !token.startsWith('s1.')) return null;
  try {
    const buf = Buffer.from(token.slice(3), 'base64url');
    const d = createDecipheriv('aes-256-gcm', SESSION_KEY, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    const p = JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString());
    return p.exp > Date.now() ? p : null;
  } catch {
    return null;
  }
}

async function sessionFor(token) {
  if (!token) return null;
  if (sessions.has(token)) return sessions.get(token);
  if (revoked.has(token)) return null;
  const p = unseal(token);
  if (!p || !BROKERS[p.broker]) return null;
  const pending = BROKERS[p.broker].connect(p.creds, { universe: p.universe })
    .then(({ session }) => { sessions.set(token, session); return session; })
    .catch(() => { sessions.delete(token); return null; });
  sessions.set(token, pending); // concurrent requests share one reconnect
  return pending;
}

// Middleware: validate Bearer token from Authorization header or ?token= query param
async function auth(req, res, next) {
  const raw = req.headers.authorization || '';
  const token = raw.startsWith('Bearer ') ? raw.slice(7) : req.query.token;
  const session = await sessionFor(token);
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
    const token = SESSION_KEY
      ? seal({ broker: broker.id, creds, universe, exp: Date.now() + SEALED_TTL_MS })
      : randomBytes(28).toString('hex');
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
  if (SESSION_KEY) revoked.add(req.token);
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
  // optional history length in calendar days (brokers that support it; capped at ~10 years)
  const days = Math.max(200, Math.min(3700, parseInt(req.query.days, 10) || 1100));
  // optional top-up: the browser keeps earlier bars and only asks for days from `since` on
  const since = /^\d{4}-\d{2}-\d{2}$/.test(req.query.since || '') ? req.query.since : null;
  return req.session.bars(symbols, days, { since });
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

export { app, BROKERS, sessions };

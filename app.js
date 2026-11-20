import express from 'express';
import cors from 'cors';
import { randomBytes, createHash, createCipheriv, createDecipheriv, timingSafeEqual } from 'crypto';
import { alpaca } from './brokers/alpaca.js';
import { ig } from './brokers/ig.js';
import { serverConfig, runTilt } from './trader.js';

// Surface unhandled rejections instead of letting them silently crash the process.
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
});

const BROKERS = { alpaca, ig };

const app = express();
const ON_VERCEL = !!process.env.VERCEL;

// ── Security basics ──────────────────────────────────────────────────────────
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  next();
});
// CORS: on Vercel only the app's own address (plus SHOAL_ALLOWED_ORIGINS) may call the API from a browser;
// locally index.html may be opened from a file or another port, so any origin is allowed there.
const EXTRA_ORIGINS = (process.env.SHOAL_ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean);
app.use(cors((req, cb) => {
  if (!ON_VERCEL && !EXTRA_ORIGINS.length) return cb(null, { origin: true });
  const origin = req.header('Origin');
  cb(null, { origin: !origin || origin === `https://${req.header('host')}` || EXTRA_ORIGINS.includes(origin) });
}));
app.use(express.json({ limit: '100kb' }));
// Rate limits per IP per minute (per server instance)
const hits = new Map();
const rateLimit = (limit, bucket) => (req, res, next) => {
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || '?';
  const k = `${bucket}:${ip}`, now = Date.now();
  let e = hits.get(k);
  if (!e || now - e.t > 60_000) { e = { t: now, n: 0 }; hits.set(k, e); }
  if (++e.n > limit) return res.status(429).json({ error: 'Too many requests; try again in a minute.' });
  if (hits.size > 5000) for (const [kk, v] of hits) if (now - v.t > 60_000) hits.delete(kk);
  next();
};
app.use('/api', rateLimit(600, 'api'));
// Optional access code: when SHOAL_ACCESS_CODE is set, connecting a broker requires it (header
// x-shoal-access), so a stranger who finds the URL can't use this server as a relay.
const ACCESS_HASH = process.env.SHOAL_ACCESS_CODE ? createHash('sha256').update(process.env.SHOAL_ACCESS_CODE).digest() : null;
const sameSecret = (a, b) => timingSafeEqual(createHash('sha256').update(String(a)).digest(), createHash('sha256').update(String(b)).digest());
const accessOk = (req) => !ACCESS_HASH || timingSafeEqual(createHash('sha256').update(String(req.header('x-shoal-access') || '')).digest(), ACCESS_HASH);

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
const SEALED_TTL_MS = 8 * 3600_000; // a stolen token works for at most 8 hours
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

// Middleware: validate the Bearer token (Authorization header only; never in a URL, where it could end up
// in logs or browser history)
async function auth(req, res, next) {
  const raw = req.headers.authorization || '';
  const token = raw.startsWith('Bearer ') ? raw.slice(7) : null;
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
app.get('/api/health', (_req, res) => res.json({ ok: true, brokers: Object.keys(BROKERS), accessCode: !!ACCESS_HASH }));

// ── Connect: validate credentials with the broker, create session ───────────
// Body: { broker: 'alpaca' | 'ig', env: 'paper' | 'live', ...credentials, symbols? }
//   alpaca: keyId, secret
//   ig:     apiKey, username, password, accountId? ('paper' maps to IG's demo environment)
app.post('/api/connect', rateLimit(10, 'connect'), async (req, res) => {
  if (!accessOk(req)) return res.status(403).json({ error: 'This Shoal server needs its access code to connect a broker.', needAccessCode: true });
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
  const symbols = (req.query.symbols || '').split(',').filter(s => SYMBOL_RE.test(s)).slice(0, 150);
  if (!symbols.length) return { status: 400, body: { error: 'symbols required' } };
  // Intraday bars (5 or 15 minutes) for the intraday lab: Alpaca only, up to 90 calendar days back
  const timeframe = req.query.timeframe || '1Day';
  if (!['1Day', '5Min', '15Min'].includes(timeframe)) return { status: 400, body: { error: 'timeframe must be 1Day, 5Min or 15Min' } };
  if (timeframe !== '1Day') {
    if (typeof req.session.intradayBars !== 'function') return { status: 400, body: { error: 'Intraday history is only available with Alpaca' } };
    const idays = Math.max(5, Math.min(90, parseInt(req.query.days, 10) || 60));
    return req.session.intradayBars(symbols, timeframe, idays);
  }
  // optional history length in calendar days (brokers that support it; capped at ~10 years)
  const days = Math.max(200, Math.min(3700, parseInt(req.query.days, 10) || 1100));
  // optional top-up: the browser keeps earlier bars and only asks for days from `since` on
  const since = /^\d{4}-\d{2}-\d{2}$/.test(req.query.since || '') ? req.query.since : null;
  return req.session.bars(symbols, days, { since });
}));

// ── SSE stream: pushes account + positions + orders + clock (+ prices for IG) ─
// EventSource can't send headers, so the browser first swaps its token for a one-minute ticket and puts
// that in the URL; the session token itself never appears in a URL.
const tickets = new Map();
const TICKET_MS = 60_000;
app.post('/api/stream-ticket', auth, (req, res) => {
  const exp = Date.now() + TICKET_MS;
  let ticket;
  if (SESSION_KEY) ticket = seal({ kind: 'ticket', token: req.token, exp });
  else { ticket = randomBytes(24).toString('hex'); tickets.set(ticket, { token: req.token, exp }); }
  res.json({ ticket, expiresInMs: TICKET_MS });
});
function tokenFromTicket(t) {
  if (!t || typeof t !== 'string') return null;
  if (SESSION_KEY) { const p = unseal(t); return p && p.kind === 'ticket' ? p.token : null; }
  const e = tickets.get(t);
  if (e && e.exp <= Date.now()) tickets.delete(t);
  return e && e.exp > Date.now() ? e.token : null;
}
app.get('/api/stream', async (req, res, next) => {
  const token = tokenFromTicket(req.query.ticket);
  const session = token && !revoked.has(token) ? await sessionFor(token) : null;
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  req.session = session; req.token = token;
  next();
}, (req, res) => {
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

// ── Server trading: Rank & tilt once a day without a browser (Vercel cron → /api/cron/tilt) ──────────
// Needs ALPACA_KEY_ID, ALPACA_SECRET (and ALPACA_ENV=paper|live) plus CRON_SECRET in the server's
// environment. Live money also needs SHOAL_SERVER_LIVE=1. Vercel sends "Authorization: Bearer CRON_SECRET".
const cronOk = (req) => !!process.env.CRON_SECRET && sameSecret(req.header('authorization') || '', `Bearer ${process.env.CRON_SECRET}`);
const serverEnabled = (cfg) => !!(cfg.keyId && cfg.secret && process.env.CRON_SECRET) && (cfg.env !== 'live' || cfg.liveAllowed);
const sameAccount = (req, cfg) => !!(req.session && req.session.keyId && cfg.keyId && req.session.keyId === cfg.keyId && req.session.env === cfg.env);
app.get('/api/cron/tilt', async (req, res) => {
  if (!cronOk(req)) return res.status(401).json({ error: 'Not authorised' });
  const cfg = serverConfig();
  if (!cfg.keyId || !cfg.secret) return res.json({ ok: true, configured: false, note: 'Set ALPACA_KEY_ID and ALPACA_SECRET to enable server trading.' });
  if (cfg.env === 'live' && !cfg.liveAllowed) return res.json({ ok: false, error: 'ALPACA_ENV is live but SHOAL_SERVER_LIVE is not 1: not trading real money.' });
  try {
    const { session } = await alpaca.connect({ keyId: cfg.keyId, secret: cfg.secret, env: cfg.env });
    const r = await runTilt(session, cfg, { dry: req.query.dry === '1' });
    console.log('[cron/tilt]', JSON.stringify(r));
    res.json(r);
  } catch (err) {
    console.error('[cron/tilt] failed:', err.message);
    res.status(502).json({ ok: false, error: err.message });
  }
});
// What the browser needs to know (no secrets): is the server trading this same account?
app.get('/api/server-trading', auth, (req, res) => {
  const cfg = serverConfig();
  res.json({ enabled: serverEnabled(cfg), configured: !!(cfg.keyId && cfg.secret), cronSecret: !!process.env.CRON_SECRET, env: cfg.env,
    liveAllowed: cfg.liveAllowed, sameAccount: sameAccount(req, cfg), topK: cfg.topK, investFraction: cfg.investFraction, watchlistSize: cfg.watchlist.length, schedule: cfg.schedule });
});
// Dry run with the browser's own session (only for the account the server trades)
app.get('/api/server-trading/preview', auth, async (req, res) => {
  const cfg = serverConfig();
  if (!sameAccount(req, cfg)) return res.status(403).json({ error: 'Preview is only available for the account the server trades.' });
  try { res.json(await runTilt(req.session, cfg, { dry: true })); }
  catch (err) { res.status(502).json({ error: err.message }); }
});

export { app, BROKERS, sessions };

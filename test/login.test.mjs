import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

// The whole app behind a username and password
let server, base, cookie;
before(async () => {
  Object.assign(process.env, { PORT: '0', SHOAL_SESSION_SECRET: 'login-test', SHOAL_LOGIN_USER: 'graeme', SHOAL_LOGIN_PASSWORD: 'correct horse', SHOAL_ACCESS_CODE: 'code-123', CRON_SECRET: 'cs' });
  ({ server } = await import('../server.js'));
  if (!server.listening) await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const get = (p, headers = {}) => fetch(base + p, { headers, redirect: 'manual' });
const login = (username, password, json = false) => fetch(base + '/api/login', {
  method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(json ? { Accept: 'application/json' } : {}) },
  body: new URLSearchParams({ username, password }),
});

test('logged out: pages redirect to the login page, the API refuses', async () => {
  for (const p of ['/', '/index.html', '/signals.js', '/swing.js']) {
    const r = await get(p);
    assert.equal(r.status, 302, p);
    assert.equal(r.headers.get('location'), '/login');
  }
  const api = await get('/api/account', { Authorization: 'Bearer anything' });
  assert.equal(api.status, 401);
  assert.equal(api.headers.get('x-shoal-login'), 'required');
  assert.equal((await get('/api/server-trading')).status, 401);
});

test('the login page, health and the cron job stay reachable', async () => {
  const page = await get('/login');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /name="password"/);
  const h = await (await get('/api/health')).json();
  assert.equal(h.login, true);
  assert.equal((await get('/api/cron/tilt')).status, 401); // reachable, but needs its own secret
});

test('wrong username or password: back to the login page, no cookie', async () => {
  for (const [u, p] of [['graeme', 'wrong'], ['someone', 'correct horse'], ['', '']]) {
    const r = await login(u, p);
    assert.equal(r.status, 303);
    assert.equal(r.headers.get('location'), '/login?e=1');
    assert.equal(r.headers.get('set-cookie'), null);
  }
});

test('right login: signed HttpOnly SameSite cookie, then the app loads', async () => {
  const r = await login('graeme', 'correct horse');
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/');
  const sc = r.headers.get('set-cookie');
  assert.match(sc, /shoal_auth=/);
  assert.match(sc, /HttpOnly/);
  assert.match(sc, /SameSite=Strict/);
  cookie = sc.split(';')[0];
  const page = await get('/', { Cookie: cookie });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>/);
  assert.equal((await get('/swing.js', { Cookie: cookie })).status, 200);
  assert.equal((await get('/login', { Cookie: cookie })).status, 302); // already logged in
});

test('a tampered or expired cookie is refused', async () => {
  const [name, val] = cookie.split('=');
  const [exp, mac] = val.split('.');
  assert.equal((await get('/', { Cookie: `${name}=${Number(exp) + 1000}.${mac}` })).status, 302);
  assert.equal((await get('/', { Cookie: `${name}=${Date.now() - 1000}.${mac}` })).status, 302);
});

test('logged in counts as having the access code', async () => {
  const h = await (await get('/api/health', { Cookie: cookie })).json();
  assert.equal(h.accessCode, false);
  const r = await fetch(base + '/api/connect', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ broker: 'nope' }) });
  assert.equal(r.status, 400); // past the access check, refused for the unknown broker
});

test('log out clears the cookie', async () => {
  const r = await fetch(base + '/api/logout', { method: 'POST', headers: { Cookie: cookie } });
  assert.match(r.headers.get('set-cookie'), /Max-Age=0/);
});

test('login attempts are rate-limited', async () => {
  let last;
  for (let k = 0; k < 12; k++) last = await login('graeme', 'nope');
  assert.equal(last.status, 429);
});

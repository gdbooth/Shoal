// Notifications (step 5): channel detection, message formats, and what the engine sends when.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notifyConfig, notify } from '../notify.js';
import { engineTick } from '../engine.js';

test('channel from SHOAL_NOTIFY_URL: off unless https; ntfy, Slack, Discord or a plain webhook', () => {
  assert.equal(notifyConfig({}).kind, 'off');
  assert.equal(notifyConfig({ SHOAL_NOTIFY_URL: 'http://ntfy.sh/x' }).kind, 'off'); // https only
  assert.equal(notifyConfig({ SHOAL_NOTIFY_URL: 'https://ntfy.sh/shoal-abc123' }).kind, 'ntfy');
  assert.equal(notifyConfig({ SHOAL_NOTIFY_URL: 'https://hooks.slack.com/services/a/b/c' }).kind, 'slack');
  assert.equal(notifyConfig({ SHOAL_NOTIFY_URL: 'https://discord.com/api/webhooks/1/x' }).kind, 'discord');
  assert.equal(notifyConfig({ SHOAL_NOTIFY_URL: 'https://example.com/hook' }).kind, 'webhook');
  assert.equal(notifyConfig({ SHOAL_NOTIFY_URL: 'https://ntfy.example.com/t', SHOAL_NOTIFY_KIND: 'ntfy' }).kind, 'ntfy');
  assert.equal(notifyConfig({ SHOAL_NOTIFY_URL: 'https://ntfy.sh/t', SHOAL_NOTIFY_LEVEL: 'all' }).level, 'all');
});

test('message formats per channel; failures are reported, never thrown', async () => {
  const calls = [];
  const f = async (url, req) => { calls.push({ url, req }); return { ok: true, status: 200 }; };
  await notify(notifyConfig({ SHOAL_NOTIFY_URL: 'https://ntfy.sh/t' }), { title: 'Shoal ✓ day', text: 'hello', priority: 'high', tags: ['warning'] }, f);
  assert.equal(calls[0].req.body, 'hello');
  assert.equal(calls[0].req.headers.Title, 'Shoal  day'); // headers are ASCII only
  assert.equal(calls[0].req.headers.Priority, '4');
  await notify(notifyConfig({ SHOAL_NOTIFY_URL: 'https://hooks.slack.com/services/a' }), { title: 'T', text: 'x' }, f);
  assert.deepEqual(JSON.parse(calls[1].req.body), { text: '*T*\nx' });
  await notify(notifyConfig({ SHOAL_NOTIFY_URL: 'https://discord.com/api/webhooks/1/x' }), { title: 'T', text: 'x' }, f);
  assert.deepEqual(JSON.parse(calls[2].req.body), { content: '**T**\nx' });
  assert.deepEqual(await notify(notifyConfig({}), { title: 'T' }, f), { sent: false, reason: 'off' });
  const bad = await notify(notifyConfig({ SHOAL_NOTIFY_URL: 'https://ntfy.sh/t' }), { title: 'T', text: 'x' }, async () => { throw new Error('offline'); });
  assert.deepEqual(bad, { sent: false, reason: 'offline' });
});

const ny = (hhmm) => new Date(`2026-12-01T${hhmm}:00-05:00`);
function world() {
  const st = { open: true, equity: 100000 };
  const mem = {};
  return {
    st,
    store: { get: async (k) => (k in mem ? JSON.parse(JSON.stringify(mem[k])) : null), put: async (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); } },
    session: {
      async req(p) { return p === '/v2/clock' ? { status: 200, body: { is_open: st.open } } : { status: 404, body: {} }; },
      async account() { return { status: 200, body: { equity: String(st.equity), cash: '1000', buying_power: '1000' } }; },
      async positions() { return { status: 200, body: [{ symbol: 'XOM', qty: '5', market_value: '400', unrealized_plpc: '-0.02', change_today: '-0.09' }] }; },
      async bars() { return { status: 200, body: { bars: {} } }; },
    },
  };
}

test('engine notifications: daily report at the close; risk alerts once a day; orders only at level all; errors', async () => {
  const w = world(), sent = [];
  const send = async (m) => { sent.push(m); return { sent: true }; };
  const strat = async () => ({ ok: true, picks: ['NVDA'], sells: [], buys: [{ sym: 'NVDA', notional: 500 }], waiting: [], orders: [{ sym: 'NVDA', side: 'buy', notional: 500, ok: true }] });
  const tick = (t, level = 'daily') => engineTick({ session: w.session, store: w.store, cfg: { dailyLossPct: 5, notify: { kind: 'ntfy', level } }, strategy: strat, learn: null, send, now: ny(t) });
  await tick('09:46');
  assert.equal(sent.length, 0); // daily level: no order notes
  w.st.equity = 94000;
  const h = await tick('10:31');
  assert.equal(h.notified, 2);
  assert.match(sent[0].title, /no new buys/); assert.equal(sent[0].priority, 'high');
  assert.match(sent[1].text, /XOM -9\.0% today/);
  await tick('11:31');
  assert.equal(sent.length, 2); // the same alerts aren't repeated the same day
  w.st.open = false;
  await tick('16:05');
  assert.match(sent[2].title, /^Shoal 2026-12-01: -6%/);
  assert.match(sent[2].text, /Equity \$94,000/);
});

test('engine notifications at level all include the open review orders; a broken channel never fails a tick', async () => {
  const w = world(), sent = [];
  const strat = async () => ({ ok: true, picks: [], sells: [], buys: [{ sym: 'NVDA', notional: 500 }], waiting: [], orders: [{ sym: 'NVDA', side: 'buy', notional: 500, ok: true }] });
  const r = await engineTick({ session: w.session, store: w.store, cfg: { notify: { kind: 'ntfy', level: 'all' } }, strategy: strat, learn: null, send: async (m) => { sent.push(m); return { sent: true }; }, now: ny('09:46') });
  assert.equal(r.notified, 1);
  assert.match(sent[0].text, /buy NVDA \$500/);
  const w2 = world();
  const r2 = await engineTick({ session: w2.session, store: w2.store, cfg: { notify: { kind: 'ntfy', level: 'all' } }, strategy: async () => { throw new Error('boom'); }, learn: null, send: async () => { throw new Error('down'); }, now: ny('09:46') });
  assert.equal(r2.ok, false); assert.equal(r2.notified, 0);
  assert.equal((await w2.store.get('state.json')).lockUntil, 0);
});

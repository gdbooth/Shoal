// Notifications from the server engine (step 5). Off unless SHOAL_NOTIFY_URL is set:
//   https://ntfy.sh/<your-topic>            push to the free ntfy app (pick a long, unguessable topic name)
//   https://hooks.slack.com/services/...     a Slack incoming webhook
//   https://discord.com/api/webhooks/...     a Discord webhook
//   any other https URL                      JSON { title, text, priority } POSTed to it
// SHOAL_NOTIFY_LEVEL: 'daily' (default: end-of-day report, errors and risk alerts) or 'all' (also every
// order the engine places). A failed notification never fails a tick. The URL is never shown in the app.

export function notifyConfig(env = process.env) {
  const url = String(env.SHOAL_NOTIFY_URL || '').trim();
  let kind = 'off';
  if (/^https:\/\//i.test(url)) {
    let host = '';
    try { host = new URL(url).hostname; } catch { host = ''; }
    kind = !host ? 'off' : host === 'ntfy.sh' || env.SHOAL_NOTIFY_KIND === 'ntfy' ? 'ntfy'
      : host === 'hooks.slack.com' ? 'slack'
      : /(^|\.)discord(app)?\.com$/.test(host) && url.includes('/api/webhooks/') ? 'discord' : 'webhook';
  }
  return { kind, url: kind === 'off' ? '' : url, level: env.SHOAL_NOTIFY_LEVEL === 'all' ? 'all' : 'daily' };
}

// High priority for errors and alerts, default for reports, low for routine order notes
const PRIO = { high: 4, default: 3, low: 2 };

export async function notify(nc, { title, text, priority = 'default', tags = [] }, fetchImpl = globalThis.fetch) {
  if (!nc || nc.kind === 'off' || !nc.url) return { sent: false, reason: 'off' };
  const body = String(text || '').slice(0, 3500);
  let req;
  if (nc.kind === 'ntfy') {
    // ntfy headers must be plain ASCII
    const ascii = (s) => String(s).replace(/[^\x20-\x7e]/g, '').slice(0, 200);
    req = { method: 'POST', headers: { Title: ascii(title), Priority: String(PRIO[priority] || 3), ...(tags.length ? { Tags: ascii(tags.join(',')) } : {}) }, body };
  } else if (nc.kind === 'slack') {
    req = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: `*${title}*\n${body}` }) };
  } else if (nc.kind === 'discord') {
    req = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: `**${title}**\n${body}`.slice(0, 1990) }) };
  } else {
    req = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, text: body, priority }) };
  }
  try {
    const r = await fetchImpl(nc.url, { ...req, signal: AbortSignal.timeout(8000) });
    return { sent: r.ok, status: r.status };
  } catch (err) {
    return { sent: false, reason: err.message };
  }
}

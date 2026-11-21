import nodeFetch from 'node-fetch';

// Use native fetch (Node 18+) when available, otherwise fall back to node-fetch.
export const fetch = globalThis.fetch ?? nodeFetch;

// Error carrying the HTTP status the route should answer with.
export class BrokerError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

// Read a response body as JSON, tolerating empty and non-JSON bodies.
export async function readBody(r) {
  const text = await r.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return { message: text }; }
}

// Sliding-window limiter: take() resolves once a request fits in the last 60 s.
export class RateLimiter {
  constructor(perMinute) {
    this.perMinute = perMinute;
    this.stamps = [];
    this.chain = Promise.resolve();
  }
  take() {
    const next = this.chain.then(async () => {
      for (;;) {
        const now = Date.now();
        this.stamps = this.stamps.filter(t => now - t < 60_000);
        if (this.stamps.length < this.perMinute) { this.stamps.push(now); return; }
        await new Promise(r => setTimeout(r, 60_000 - (now - this.stamps[0]) + 50));
      }
    });
    this.chain = next.catch(() => {});
    return next;
  }
}

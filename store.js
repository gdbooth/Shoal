// Durable JSON storage for the server engine: decisions, runs, daily reports and state survive restarts and
// work without a browser. Vercel Blob (private) when BLOB_READ_WRITE_TOKEN is set; otherwise plain files
// (local runs and tests: SHOAL_DATA_DIR, default ./.data).
import fs from 'fs';
import path from 'path';

const PREFIX = 'shoal/';

function fileStore(dir) {
  const full = (key) => path.join(dir, ...key.split('/'));
  return {
    kind: 'file',
    async get(key) {
      try { return JSON.parse(fs.readFileSync(full(key), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    },
    async put(key, value) {
      const f = full(key);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      const tmp = `${f}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(value));
      fs.renameSync(tmp, f); // atomic replace
    },
    async list(prefix) {
      const d = full(prefix);
      try { return fs.readdirSync(d).filter(n => n.endsWith('.json')).map(n => prefix.replace(/\/?$/, '/') + n).sort(); } catch { return []; }
    },
  };
}

function blobStore(token) {
  let mod = null;
  const blob = async () => (mod = mod || (await import('@vercel/blob')));
  return {
    kind: 'blob',
    async get(key) {
      const { get } = await blob();
      const r = await get(PREFIX + key, { access: 'private', useCache: false, token }).catch(e => { if (e && /not ?found/i.test(e.name + e.message)) return null; throw e; });
      if (!r || r.statusCode !== 200 || !r.stream) return null;
      return JSON.parse(await new Response(r.stream).text());
    },
    async put(key, value) {
      const { put } = await blob();
      await put(PREFIX + key, JSON.stringify(value), { access: 'private', allowOverwrite: true, addRandomSuffix: false, contentType: 'application/json', token });
    },
    async list(prefix) {
      const { list } = await blob();
      const out = [];
      let cursor;
      do {
        const r = await list({ prefix: PREFIX + prefix, cursor, token });
        out.push(...r.blobs.map(b => b.pathname.slice(PREFIX.length)));
        cursor = r.hasMore ? r.cursor : undefined;
      } while (cursor);
      return out.sort();
    },
  };
}

export function createStore(env = process.env) {
  if (env.BLOB_READ_WRITE_TOKEN) return blobStore(env.BLOB_READ_WRITE_TOKEN);
  return fileStore(env.SHOAL_DATA_DIR || (env.VERCEL ? '/tmp/shoal-data' : path.resolve('.data')));
}
export const storeKind = (env = process.env) => (env.BLOB_READ_WRITE_TOKEN ? 'blob' : env.VERCEL ? 'temporary files (not durable: connect a Blob store)' : 'local files');

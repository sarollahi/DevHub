import http from 'node:http';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

const ID = /^[a-f0-9]{64}$/;
const REPO = /^[a-f0-9-]{36}$/i;
export class CacheUnavailable extends Error {}

// Native clients and CI workers share one daemon; callers choose only requested IDs.
// No implicit full-repository materialization or client-side ancestry calculation.
export async function getCachedObject({ socketPath, host, port, token, repositoryId, id, timeoutMs = 15000 }) {
  if (!REPO.test(repositoryId) || !ID.test(id)) throw new Error('Invalid repository or object ID');
  return new Promise((resolve, reject) => {
    const req = http.get({ socketPath, host, port, path: `/v1/objects/${repositoryId}/${id}`, headers: token ? { authorization: `Bearer ${token}` } : {}, timeout: timeoutMs }, res => {
      if (res.statusCode !== 200) { res.resume(); reject(new CacheUnavailable(`Cache returned ${res.statusCode}`)); return; }
      const kind = res.headers['x-devhub-object-kind'];
      if (kind !== 'BLOB' && kind !== 'TREE') { res.resume(); reject(new CacheUnavailable('Invalid object kind')); return; }
      const hash = createHash('sha256').update(kind).update('\0');
      const chunks = []; let count = 0;
      res.on('data', chunk => { count += chunk.length; if (count > 16 * 1024 * 1024) { res.destroy(new Error('Object exceeds client limit')); return; } hash.update(chunk); chunks.push(chunk); });
      res.once('error', reject);
      res.once('end', () => { if (hash.digest('hex') !== id) reject(new CacheUnavailable('Corrupt cache response')); else resolve({ id, kind, data: Buffer.concat(chunks) }); });
    });
    req.once('timeout', () => req.destroy(new CacheUnavailable('Cache timed out')));
    req.once('error', error => reject(new CacheUnavailable(error.message)));
  });
}

// Stream a selected blob into an atomic workspace file without buffering it.
export async function materializeCachedObject(opts, destination) {
  const { id, repositoryId, socketPath, host, port, token, timeoutMs = 15000 } = opts;
  if (!REPO.test(repositoryId) || !ID.test(id)) throw new Error('Invalid repository or object ID');
  const temp = `${destination}.devhub-part-${process.pid}-${Date.now()}`;
  try {
    await new Promise((resolve, reject) => {
      const req = http.get({ socketPath, host, port, path: `/v1/objects/${repositoryId}/${id}`, headers: token ? { authorization: `Bearer ${token}` } : {}, timeout: timeoutMs }, async res => {
        if (res.statusCode !== 200) { res.resume(); reject(new CacheUnavailable(`Cache returned ${res.statusCode}`)); return; }
        const kind = res.headers['x-devhub-object-kind'];
        if (kind !== 'BLOB') { res.resume(); reject(new CacheUnavailable('Materialization requires a blob')); return; }
        const hash = createHash('sha256').update(kind).update('\0'); let size = 0;
        try {
          await pipeline(res, new Transform({ transform(chunk, _, cb) { size += chunk.length; if (size > 16 * 1024 * 1024) return cb(new Error('Object too large')); hash.update(chunk); cb(null, chunk); } }), createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
          if (hash.digest('hex') !== id) throw new CacheUnavailable('Corrupt cache response');
          await rename(temp, destination); resolve();
        } catch (e) { reject(e); }
      });
      req.once('timeout', () => req.destroy(new CacheUnavailable('Cache timed out')));
      req.once('error', reject);
    });
  } finally { await rm(temp, { force: true }); }
}

import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { ObjectCache } from '../src/cache/daemon.mjs';
import { getCachedObject } from '../src/cache/client.mjs';

const repositoryId = randomUUID();
const objects = Array.from({ length: 200 }, (_, i) => {
  const content = Buffer.from(`// file ${i}\n${'source'.repeat(100)}\n`);
  return { content, id: createHash('sha256').update('BLOB\0').update(content).digest('hex') };
});
const byId = new Map(objects.map(item => [item.id, item]));
let remoteRequests = 0;
const origin = http.createServer(async (req, res) => {
  remoteRequests++;
  const id = /\/objects\/([a-f0-9]{64})/.exec(req.url)?.[1];
  const entry = byId.get(id);
  if (!entry) { res.writeHead(404); res.end(); return; }
  // Fixed network delay makes cold and warm cases comparable between local runs.
  await new Promise(resolve => setTimeout(resolve, 12));
  res.writeHead(200, { 'x-devhub-object-kind': 'BLOB', 'content-length': entry.content.length }); res.end(entry.content);
});
await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
const directory = await mkdtemp(join(tmpdir(), 'devhub-cache-bench-'));
const cache = new ObjectCache({ root: join(directory, 'cache'), socketPath: join(directory, 'cache.sock'), originUrl: `http://127.0.0.1:${origin.address().port}`, maxDiskBytes: 4 * 1024 * 1024, maxObjectBytes: 4096, maxInflight: 8, maxQueued: 64, maxReaderQueue: 256 });
try {
  const setupStarted = performance.now(); await cache.start();
  const coldStartMs = performance.now() - setupStarted;
  const fetchSelected = async indexes => Promise.all(indexes.map(i => getCachedObject({ socketPath: join(directory, 'cache.sock'), repositoryId, id: objects[i].id })));
  const measure = async (name, action) => {
    const before = remoteRequests; const started = performance.now(); await action();
    return { scenario: name, durationMs: Math.round((performance.now() - started) * 100) / 100, upstreamRequests: remoteRequests - before };
  };
  const sparse = Array.from({ length: 20 }, (_, i) => i * 5); // 10% of repository
  const scenarios = [];
  scenarios.push(await measure('cold concurrent CI (8 jobs, same sparse selection)', () => Promise.all(Array.from({ length: 8 }, () => fetchSelected(sparse)))));
  scenarios.push(await measure('warm concurrent CI (8 repeated checkouts)', () => Promise.all(Array.from({ length: 8 }, () => fetchSelected(sparse)))));
  scenarios.push(await measure('cache misses (20 previously unselected objects)', () => fetchSelected(Array.from({ length: 20 }, (_, i) => i * 5 + 1))));
  scenarios.push(await measure('warm sparse workspace (20 selected files)', () => fetchSelected(sparse)));
  process.stdout.write(JSON.stringify({ coldStartMs: Math.round(coldStartMs * 100) / 100, objectsInRepository: objects.length, selectedSparseObjects: sparse.length, serverDelayMs: 12, scenarios, counters: cache.stats }, null, 2) + '\n');
} catch(error) { console.error('Benchmark error', error, cache.stats, {active:cache.capacity.active, waiting:cache.capacity.waiters.length, reserved:cache.reserved, bytes:cache.bytes}); throw error; } finally { await cache.close(); await new Promise(resolve => origin.close(resolve)); await rm(directory, { recursive: true, force: true }); }

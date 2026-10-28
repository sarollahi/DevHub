import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { ObjectCache } from '../src/cache/daemon.mjs';
import { getCachedObject } from '../src/cache/client.mjs';

// Deterministic, synthetic localhost benchmark. These are measured results;
// they are NOT deployed production numbers or a native-vs-Git comparison.
const repositoryId = randomUUID();
const objects = Array.from({ length: 500 }, (_, i) => {
  const data = Buffer.from(('path-' + i + ':' + 'data'.repeat(512)).slice(0, 2048));
  return { id: createHash('sha256').update('BLOB\0').update(data).digest('hex'), data };
});
const lookup = new Map(objects.map(o => [o.id, o]));
let originRequests = 0, originBytes = 0;
const origin = http.createServer(async (req, res) => {
  originRequests++;
  const id = /\/objects\/([a-f0-9]{64})/.exec(req.url)?.[1];
  const item = lookup.get(id);
  if (!item) { res.writeHead(404); res.end(); return; }
  await new Promise(resolve => setTimeout(resolve, 12));
  originBytes += item.data.length;
  res.writeHead(200, { 'content-length': item.data.length, 'x-devhub-object-kind': 'BLOB' });
  res.end(item.data);
});
await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
const directory = await mkdtemp(join(tmpdir(), 'devhub-hierarchy-benchmark-'));
const originUrl = 'http://127.0.0.1:' + origin.address().port;
const percentile = (sorted, fraction) => sorted.length ? Number(sorted[Math.ceil(sorted.length * fraction) - 1].toFixed(2)) : null;
const results = [];
try {
  for (const fraction of [0.01, 0.10, 0.50]) {
    const count = Math.round(objects.length * fraction);
    const prefix = String(count);
    const socketPath = join(directory, prefix + '.sock');
    const cache = new ObjectCache({
      root: join(directory, prefix), socketPath, originUrl,
      maxDiskBytes: 4 * 1024 * 1024, maxObjectBytes: 4096,
      maxInflight: 8, maxQueued: 600, maxReaders: 64, maxReaderQueue: 1024,
    });
    await cache.start();
    try {
      const selected = objects.slice(0, count);
      for (const phase of ['cold', 'warm']) {
        const before = { originRequests, originBytes, hits: cache.stats.hits, misses: cache.stats.misses };
        const start = performance.now(), cpu = process.cpuUsage();
        let maxRssBytes = process.memoryUsage().rss, clientReceivedBytes = 0;
        const samples = [], timer = setInterval(() => {
          maxRssBytes = Math.max(maxRssBytes, process.memoryUsage().rss);
        }, 5);
        try {
          await Promise.all(Array.from({ length: 4 }, async () => {
            // Bound each client's active requests. A workload that saturates the
            // local socket's listen backlog measures EAGAIN, not cache latency.
            for (let offset = 0; offset < selected.length; offset += 16) {
              await Promise.all(selected.slice(offset, offset + 16).map(async object => {
                const requestStart = performance.now();
                const read = await getCachedObject({ socketPath, repositoryId, id: object.id });
                samples.push(performance.now() - requestStart);
                clientReceivedBytes += read.data.length;
                if (!read.data.equals(object.data)) throw new Error('Verification mismatch');
              }));
            }
          }));
        } finally { clearInterval(timer); }
        maxRssBytes = Math.max(maxRssBytes, process.memoryUsage().rss);
        const time = performance.now() - start, usage = process.cpuUsage(cpu);
        const deltaHit = cache.stats.hits - before.hits, deltaMiss = cache.stats.misses - before.misses;
        samples.sort((a, b) => a - b);
        results.push({
          selectionPercent: fraction * 100, phase, selectedPaths: count, concurrentClients: 4,
          durationMs: +time.toFixed(2),
          latencyMs: { p50: percentile(samples, 0.50), p95: percentile(samples, 0.95), p99: percentile(samples, 0.99) },
          clientReceivedBytes, originTransferredBytes: originBytes - before.originBytes,
          originRequests: originRequests - before.originRequests,
          hitRatePercent: deltaHit + deltaMiss ? +(100 * deltaHit / (deltaHit + deltaMiss)).toFixed(2) : 0,
          cpuTimeMs: +((usage.user + usage.system) / 1000).toFixed(2),
          peakProcessRssBytes: maxRssBytes, diskCacheBytes: cache.bytes,
          integrityFailures: cache.stats.integrityFailures,
        });
      }
    } finally { await cache.close(); }
  }
  process.stdout.write(JSON.stringify({
    benchmark: 'simulated-localhost-blob-cache', objectCount: objects.length,
    originLatencyMs: 12, objectSizeBytes: 2048, results,
    limitations: ['not a native filesystem checkout', 'not a Git checkout', 'not a remote or production benchmark'],
  }, null, 2) + '\n');
} finally {
  await new Promise(resolve => origin.close(resolve));
  await rm(directory, { recursive: true, force: true });
}

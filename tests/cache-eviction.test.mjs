import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObjectCache } from '../src/cache/daemon.mjs';

const newFixture = async (evictionWaitMs) => {
  const dir = await mkdtemp(join(tmpdir(), 'devhub-eviction-'));
  const cache = new ObjectCache({
    root: join(dir, 'cache'), socketPath: join(dir, 'socket'),
    originUrl: 'http://127.0.0.1:1', maxDiskBytes: 2048,
    maxObjectBytes: 1024, evictionWaitMs,
  });
  const repositoryId = randomUUID();
  const content = Buffer.alloc(950, 65);
  const id = createHash('sha256').update('BLOB').update('\0').update(content).digest('hex');
  const key = createHash('sha256').update(repositoryId).update('\0').update(id).digest('hex');
  cache.entries.set(key, { id, repositoryId, kind: 'BLOB', size: content.length, time: Date.now() });
  cache.bytes = content.length;
  cache.reserved = 1024; // Simulate next immutable object reservation under a tiny disk budget.
  cache.activeReaders.set(key, 1); // A verified response is still streaming to its reader.
  return { cache, key, dir };
};

test('cache admission waits briefly for an active reader to drain before evicting', async t => {
  const {cache, key, dir} = await newFixture(500);
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const timer = setTimeout(() => cache.activeReaders.delete(key), 70);
  t.after(() => clearTimeout(timer));
  const before = Date.now();
  await cache.evictTo(0, 1);
  assert.ok(Date.now() - before >= 55, 'the active reader was not evicted prematurely');
  assert.equal(cache.entries.size, 0);
  assert.equal(cache.bytes, 0);
  assert.equal(cache.stats.evictions, 1);
});

test('genuine exhausted cache still fails closed after bounded reader drain', async t => {
  const {cache, key, dir} = await newFixture(80);
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const before = Date.now();
  await assert.rejects(cache.evictTo(0, 1), error =>
    error.status === 503 && /bounded reader drain/.test(error.message));
  assert.ok(Date.now() - before >= 70, 'a busy reader was rejected before the bounded wait');
  assert.equal(cache.activeReaders.get(key), 1, 'active reader must remain protected');
  assert.equal(cache.entries.size, 1);
  assert.equal(cache.stats.evictions, 0);
});

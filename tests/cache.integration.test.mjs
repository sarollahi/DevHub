import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { getCachedObject, materializeCachedObject, CacheUnavailable } from '../src/cache/client.mjs';
import { ObjectCache } from '../src/cache/daemon.mjs';

const repo = randomUUID();
const kindHash = (kind, data) => createHash('sha256').update(kind).update('\0').update(data).digest('hex');
const blob = (text) => { const data = Buffer.from(text); return { data, kind: 'BLOB', id: kindHash('BLOB', data) }; };
const wait = ms => new Promise(r => setTimeout(r, ms));
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${server.address().port}`; }
async function status(socketPath) { return new Promise((resolve, reject) => http.get({ socketPath, path: '/v1/status' }, res => {
  const chunks = []; res.on('data', c => chunks.push(c)); res.once('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString()))); res.once('error', reject);
}).once('error', reject)); }
async function start(root, socket, originUrl, options = {}) {
  const entry = resolve('src/cache/daemon.mjs');
  const child = spawn(process.execPath, [entry], { env: { ...process.env,
    DEVHUB_CACHE_DIR: root, DEVHUB_CACHE_SOCKET: socket, DEVHUB_ORIGIN_URL: originUrl,
    DEVHUB_CACHE_DISK_BYTES: String(options.maxDiskBytes ?? 64 * 1024),
    DEVHUB_CACHE_OBJECT_BYTES: String(options.maxObjectBytes ?? 1024),
    DEVHUB_REGIONAL_URL: options.regionalUrl || '', DEVHUB_REGIONAL_TOKEN: options.regionalToken || '',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = ''; child.stderr.on('data', c => { errors += c; });
  for (let n = 0; n < 100; n++) {
    if (child.exitCode !== null) throw Error(`daemon exited: ${errors}`);
    try { await status(socket); return { child, errors: () => errors }; } catch { await wait(25); }
  }
  child.kill(); throw Error(`daemon failed startup: ${errors}`);
}
async function stop(instance) { instance.child.kill('SIGTERM'); await new Promise(resolve => instance.child.once('exit', resolve)); }
async function probe(socket, target) {
  return new Promise((resolve, reject) => {
    const code = `import {getCachedObject} from ${JSON.stringify(new URL('../src/cache/client.mjs', import.meta.url).href)}; const r=await getCachedObject({socketPath:process.argv[1],repositoryId:process.argv[2],id:process.argv[3]}); process.stdout.write(r.data.toString('utf8'));`;
    const p = spawn(process.execPath, ['--input-type=module', '-e', code, socket, repo, target], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = []; const err = [];
    p.stdout.on('data', b => out.push(b)); p.stderr.on('data', b => err.push(b));
    p.on('exit', c => c === 0 ? resolve(Buffer.concat(out).toString()) : reject(new Error(Buffer.concat(err).toString())));
    p.on('error', reject);
  });
}

test('shared daemon: real independent clients, coalescing, persistent cache, tamper recovery and bounded eviction', { timeout: 60000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'devhub-node-cache-')); const socket = join(dir, 'cache.sock'); const root = join(dir, 'data');
  const items = [blob('alpha-worker-tree'), blob('beta-worker-tree'), blob('gamma'), blob('delta')];
  let requests = 0;
  let corrupt = false;
  const server = http.createServer(async (req, res) => {
    requests++;
    const object = items.find(x => req.url.includes(x.id));
    if (!object) { res.writeHead(404); res.end(); return; }
    await wait(100);
    const bytes = corrupt ? Buffer.from('tampered') : object.data;
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'x-devhub-object-kind': object.kind, 'content-length': bytes.length });
    res.end(bytes);
  });
  const url = await listen(server);
  let daemon;
  t.after(async () => { if (daemon && daemon.child.exitCode === null) await stop(daemon); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  daemon = await start(root, socket, url, { maxDiskBytes: 2048, maxObjectBytes: 1024 });
  const workers = await Promise.all(Array.from({ length: 12 }, () => probe(socket, items[0].id)));
  assert.deepEqual(workers, Array(12).fill(items[0].data.toString()));
  assert.equal(requests, 1, 'one object download for concurrent independent clients');
  assert.ok((await status(socket)).coalesced > 0);
  await stop(daemon); daemon = await start(root, socket, url, { maxDiskBytes: 2048, maxObjectBytes: 1024 });
  assert.equal((await getCachedObject({ socketPath: socket, repositoryId: repo, id: items[0].id })).data.toString(), 'alpha-worker-tree');
  assert.equal(requests, 1, 'warm cache survives daemon restart');
  const files = (await readdir(join(root, 'objects'), { withFileTypes: true })).filter(d => d.isDirectory());
  const objectFiles = (await Promise.all(files.map(d => readdir(join(root, 'objects', d.name))))).flat();
  const bin = objectFiles.find(f => f.endsWith('.bin'));
  const sh = files.find(d => objectFiles.includes(bin));
  await writeFile(join(root, 'objects', sh.name, bin), Buffer.from('forged-data'), { flag: 'w' });
  assert.equal((await getCachedObject({ socketPath: socket, repositoryId: repo, id: items[0].id })).data.toString(), 'alpha-worker-tree');
  assert.equal(requests, 2, 'tamper triggers fresh authoritative download');
  assert.ok((await status(socket)).integrityFailures > 0);
  const destination = join(dir, 'workspace-file');
  await materializeCachedObject({ socketPath: socket, repositoryId: repo, id: items[1].id }, destination);
  assert.deepEqual(await readFile(destination), items[1].data);
  assert.equal((await status(socket)).entries, 2);
  for (const x of items.slice(2)) await getCachedObject({ socketPath: socket, repositoryId: repo, id: x.id });
  assert.ok((await status(socket)).bytes <= 2048);
  const missing = '0'.repeat(64);
  await assert.rejects(() => getCachedObject({ socketPath: socket, repositoryId: repo, id: missing }), CacheUnavailable);
  assert.ok((await status(socket)).upstreamRequests >= 4);
  const treeBytes = Buffer.from('[]');
  const tree = { id: kindHash('TREE', treeBytes), kind: 'TREE', data: treeBytes };
  items.push(tree);
  const treeResult = await getCachedObject({ socketPath: socket, repositoryId: repo, id: tree.id });
  assert.equal(treeResult.kind, 'TREE');
  assert.deepEqual(treeResult.data, treeBytes);
  for (const large of ['A', 'B', 'C']) { const item = blob(large.repeat(950)); items.push(item); await getCachedObject({ socketPath: socket, repositoryId: repo, id: item.id }); }
  assert.ok((await status(socket)).evictions > 0, 'disk budget forces real eviction');
  corrupt = true;
  const wrong = blob('never trust upstream without checking');
  items.push(wrong);
  await assert.rejects(() => getCachedObject({ socketPath: socket, repositoryId: repo, id: wrong.id }), CacheUnavailable);
  assert.equal((await status(socket)).integrityFailures >= 2, true);
});

test('regional hierarchy: cache misses only travel upstream once; regional outage falls back with bounded fan-out', { timeout: 30000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'devhub-regional-'));
  const selected = blob('requested sparse file'); let originCalls = 0; let regionCalls = 0;
  const origin = http.createServer((req, res) => { originCalls++; if (!req.url.includes(repo)) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'x-devhub-object-kind': selected.kind }); res.end(selected.data); });
  const region = http.createServer((req, res) => { regionCalls++; res.writeHead(503); res.end(); });
  const url = await listen(origin); const regionalUrl = await listen(region);
  let daemon;
  t.after(async () => { if (daemon?.child.exitCode === null) await stop(daemon); await Promise.all([new Promise(r => origin.close(r)), new Promise(r => region.close(r))]); await rm(dir, { recursive: true, force: true }); });
  daemon = await start(join(dir, 'data'), join(dir, 'cache.sock'), url, { regionalUrl });
  const values = await Promise.all(Array.from({ length: 20 }, () => getCachedObject({ socketPath: join(dir, 'cache.sock'), repositoryId: repo, id: selected.id })));
  assert.equal(values.length, 20); assert.equal(originCalls, 1); assert.equal(regionCalls, 1);
  const valuesAgain = await Promise.all(Array.from({ length: 20 }, () => getCachedObject({ socketPath: join(dir, 'cache.sock'), repositoryId: repo, id: selected.id })));
  assert.equal(valuesAgain.length, 20); assert.equal(originCalls, 1);
  const badRepo = randomUUID();
  await assert.rejects(() => getCachedObject({ socketPath: join(dir, 'cache.sock'), repositoryId: badRepo, id: selected.id }), CacheUnavailable);
});

test('regional cache is populated once and reused by an independent node cache', { timeout: 30000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'devhub-region-hit-'));
  const selected = blob('regional immutable blob'); let originCalls = 0;
  const origin = http.createServer((_req, res) => { originCalls++; res.writeHead(200, { 'x-devhub-object-kind': selected.kind }); res.end(selected.data); });
  const url = await listen(origin);
  const temporary = http.createServer(); await listen(temporary);
  const port = temporary.address().port; await new Promise(resolve => temporary.close(resolve));
  const token = randomUUID().replaceAll('-', '');
  const regional = new ObjectCache({ root: join(dir, 'region'), port, host: '127.0.0.1', accessToken: token, originUrl: url, maxDiskBytes: 65536, maxObjectBytes: 1024 });
  let local;
  t.after(async () => { if (local?.child.exitCode === null) await stop(local); await regional.close(); await new Promise(resolve => origin.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  await regional.start();
  local = await start(join(dir, 'node1'), join(dir, 'node1.sock'), url, { regionalUrl: `http://127.0.0.1:${port}`, regionalToken: token });
  assert.deepEqual((await getCachedObject({ socketPath: join(dir, 'node1.sock'), repositoryId: repo, id: selected.id })).data, selected.data);
  assert.equal(originCalls, 1);
  await stop(local);
  local = await start(join(dir, 'node2'), join(dir, 'node2.sock'), url, { regionalUrl: `http://127.0.0.1:${port}`, regionalToken: token });
  assert.deepEqual((await getCachedObject({ socketPath: join(dir, 'node2.sock'), repositoryId: repo, id: selected.id })).data, selected.data);
  assert.equal(originCalls, 1, 'new node cache must hit warmed regional cache');
  assert.equal(regional.stats.hits, 1);
});

test('authoritative S3 streaming fallback preserves immutable object verification', { timeout: 30000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'devhub-s3-cache-'));
  const selected = blob('streamed authority bytes');
  let jsonReads = 0; let streamingReads = 0;
  const origin = http.createServer((req, res) => {
    if (req.url.includes('/api/v2/')) { jsonReads++; res.writeHead(413, { 'content-type': 'application/json' }); res.end('{"error":"STREAM_REQUIRED"}'); return; }
    if (req.url.includes('/content')) { streamingReads++; res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(selected.data); return; }
    res.writeHead(404); res.end();
  });
  const url = await listen(origin); let daemon;
  t.after(async () => { if (daemon?.child.exitCode === null) await stop(daemon); await new Promise(r => origin.close(r)); await rm(dir, { recursive: true, force: true }); });
  const socket = join(dir, 'node.sock'); daemon = await start(join(dir, 'data'), socket, url);
  assert.deepEqual((await getCachedObject({ socketPath: socket, repositoryId: repo, id: selected.id })).data, selected.data);
  assert.equal(jsonReads, 1); assert.equal(streamingReads, 1);
  assert.deepEqual((await getCachedObject({ socketPath: socket, repositoryId: repo, id: selected.id })).data, selected.data);
  assert.equal(streamingReads, 1, 'verified streaming bytes are shared without another request');
});


test('node cache reauthorizes every warm hit and rejects cross-tenant credentials', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'devhub-auth-cache-'));
  const repositoryId = randomUUID();
  const selected = blob('private authorized content');
  let originReads = 0, authChecks = 0;
  const origin = http.createServer((req, res) => {
    if (req.method === 'HEAD' && req.url.endsWith('/authorize')) {
      authChecks++;
      res.writeHead(req.headers.authorization === 'Bearer authorized-credential-000000000000' ? 204 : 403);
      res.end();
      return;
    }
    originReads++;
    res.writeHead(200, { 'x-devhub-object-kind': 'BLOB', 'content-length': selected.data.length });
    res.end(selected.data);
  });
  const url = await listen(origin);
  const socketPath = join(directory, 'cache.sock');
  const cache = new ObjectCache({
    root: join(directory, 'objects'), socketPath, originUrl: url,
    originToken: 'internal-origin-service-credential', requireClientAuthorization: true,
    allowedRepositories: [repositoryId],
  });
  t.after(async () => {
    await cache.close();
    await new Promise(resolve => origin.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  await cache.start();
  const allowed = { socketPath, repositoryId, id: selected.id, token: 'authorized-credential-000000000000' };
  const denied = { ...allowed, token: 'unauthorized-credential-0000000000' };
  await assert.rejects(() => getCachedObject(denied), CacheUnavailable);
  assert.equal(originReads, 0, 'denial must occur before filling a cache miss');
  assert.deepEqual((await getCachedObject(allowed)).data, selected.data);
  assert.deepEqual((await getCachedObject(allowed)).data, selected.data);
  assert.equal(originReads, 1);
  await assert.rejects(() => getCachedObject(denied), CacheUnavailable);
  assert.equal(originReads, 1, 'denied caller must never receive existing warm bytes');
  assert.equal(authChecks, 4, 'authorization must never be cached');
  assert.equal(cache.stats.authorizationDenials, 2);
  await assert.rejects(() => getCachedObject({ ...allowed, repositoryId: randomUUID() }), CacheUnavailable);
});


test('bounded retry recovers transient origin failure and rejects unsafe configuration', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'devhub-retry-cache-'));
  const r = randomUUID(), x = blob('retryable');
  let hits = 0;
  const origin = http.createServer((_req, res) => {
    hits++;
    if (hits === 1) { res.writeHead(503); res.end(); return; }
    res.writeHead(200, { 'x-devhub-object-kind': 'BLOB' }); res.end(x.data);
  });
  const url = await listen(origin);
  const cache = new ObjectCache({ root: join(dir, 'data'), socketPath: join(dir, 'cache.sock'), originUrl: url });
  t.after(async () => { await cache.close(); await new Promise(resolve => origin.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  await cache.start();
  assert.deepEqual((await getCachedObject({ socketPath: join(dir, 'cache.sock'), repositoryId: r, id: x.id })).data, x.data);
  assert.equal(hits, 2);
  assert.throws(() => new ObjectCache({ root: join(dir, 'invalid'), socketPath: join(dir, 'other.sock'),
    originUrl: url, originToken: 'privileged-token', requireClientAuthorization: false }), /requires per-caller authorization/);
});


test('durable journal resumes verified chunks after daemon restart and detects tampering', { timeout: 45000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'devhub-resume-'));
  const socket = join(dir, 'node.sock'), root = join(dir, 'objects');
  const big = Buffer.alloc(768 * 1024 + 11, 0x61);
  const second = Buffer.alloc(768 * 1024 + 11, 0x62);
  const objects = [big, second].map(data => ({
    data, kind: 'BLOB', id: kindHash('BLOB', data),
  }));
  const partialFailure = new Set(objects.map(item => item.id));
  const rangeRequests = [];
  let fullRequests = 0;
  const origin = http.createServer((req, res) => {
    const item = objects.find(x => req.url.includes(x.id));
    if (!item) { res.writeHead(404); res.end(); return; }
    const rawRange = req.headers.range;
    if (rawRange) {
      const offset = Number(/^bytes=(\d+)-$/.exec(rawRange)?.[1]);
      rangeRequests.push(offset);
      res.writeHead(206, {
        'x-devhub-object-kind': 'BLOB', etag: '"' + item.id + '"',
        'content-range': 'bytes ' + offset + '-' + (item.data.length - 1) + '/' + item.data.length,
        'content-length': item.data.length - offset,
      });
      res.end(item.data.subarray(offset));
      return;
    }
    fullRequests++;
    res.writeHead(200, { 'x-devhub-object-kind': 'BLOB', 'content-length': item.data.length });
    if (partialFailure.delete(item.id)) {
      res.write(item.data.subarray(0, 512 * 1024));
      setTimeout(() => res.destroy(), 75);
      return;
    }
    res.end(item.data);
  });
  const url = await listen(origin);
  let daemon;
  const startCache = async () => {
    daemon = new ObjectCache({
      root, socketPath: socket, originUrl: url,
      maxDiskBytes: 4 * 1024 * 1024, maxObjectBytes: 1024 * 1024,
      maxOriginRetries: 0,
    });
    await daemon.start();
  };
  t.after(async () => {
    if (daemon) await daemon.close();
    await new Promise(resolve => origin.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const opts = id => ({ socketPath: socket, repositoryId: repo, id });
  await startCache();
  await assert.rejects(() => getCachedObject(opts(objects[0].id)));
  const shards = await readdir(join(root, 'objects'), { withFileTypes: true });
  const folders = shards.filter(s => s.isDirectory()).map(s => join(root, 'objects', s.name));
  const journals = (await Promise.all(folders.map(p => readdir(p)))).flat().filter(x => x.endsWith('.json.resume'));
  assert.equal(journals.length, 1, 'interrupted transfer must leave a persisted journal');
  await daemon.close(); daemon = null;
  await startCache();
  assert.deepEqual((await getCachedObject(opts(objects[0].id))).data, big);
  assert.deepEqual(rangeRequests, [512 * 1024], 'only unfinished bytes should transfer after restart');
  assert.equal(fullRequests, 1, 'no redundant full download');
  await assert.rejects(() => getCachedObject(opts(objects[1].id)));
  const shardName = await readdir(join(root, 'objects'));
  const staged = [];
  for (const folder of shardName) {
    for (const name of await readdir(join(root, 'objects', folder))) {
      if (name.endsWith('.bin.resume')) staged.push(join(root, 'objects', folder, name));
    }
  }
  assert.equal(staged.length, 1);
  await writeFile(staged[0], Buffer.alloc(512 * 1024, 0x7f));
  assert.deepEqual((await getCachedObject(opts(objects[1].id))).data, second,
    'corrupt journal is discarded and safe full transfer succeeds');
  assert.equal(fullRequests, 3, 'tampered staged data must not be reused');
});

import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, chmod, open, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform, Readable } from 'node:stream';

const ID = /^[a-f0-9]{64}$/;
const REPOSITORY = /^[a-f0-9-]{36}$/i;
const KINDS = new Set(['BLOB', 'TREE']);
const json = (res, code, value, extra = {}) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra }); res.end(JSON.stringify(value)); };
const keyOf = (repo, id) => createHash('sha256').update(repo).update('\0').update(id).digest('hex');

class Capacity {
  constructor(maxActive, maxWaiting) { this.maxActive = maxActive; this.maxWaiting = maxWaiting; this.active = 0; this.waiters = []; }
  async acquire() {
    if (this.active < this.maxActive) { this.active++; return () => this.release(); }
    if (this.waiters.length >= this.maxWaiting) throw Object.assign(new Error('Capacity exhausted'), { status: 503 });
    await new Promise(resolve => this.waiters.push(resolve));
    return () => this.release();
  }
  release() { const next = this.waiters.shift(); if (next) next(); else this.active--; }
}
class Circuit {
  constructor(config) { this.failures = 0; this.until = 0; this.config = config; }
  ready() { return Date.now() >= this.until; }
  success() { this.failures = 0; this.until = 0; }
  failure() {
    this.failures++;
    if (this.failures >= this.config.failureThreshold) {
      const power = Math.min(10, this.failures - this.config.failureThreshold);
      const delay = Math.min(this.config.breakerMaxMs, this.config.breakerBaseMs * (2 ** power));
      this.until = Date.now() + Math.floor(delay * (0.8 + Math.random() * 0.2));
    }
  }
}

export class ObjectCache {
  constructor(options) {
    this.options = {
      maxDiskBytes: 512 * 1024 * 1024, maxObjectBytes: 16 * 1024 * 1024,
      maxEntries: 20000, maxInflight: 8, maxQueued: 32,
      maxReaders: 32, maxReaderQueue: 128, timeoutMs: 12000,
      failureThreshold: 3, breakerBaseMs: 1000, breakerMaxMs: 60000, ...options,
    };
    const o = this.options;
    if (!o.root || !o.originUrl || (!o.socketPath && !o.port) || o.maxObjectBytes > o.maxDiskBytes || !Number.isSafeInteger(o.maxDiskBytes) || o.maxDiskBytes <= 0 || o.maxEntries < 1 || o.maxInflight < 1 || o.maxReaders < 1) throw new Error('Invalid cache configuration');
    if (o.port && (!o.accessToken || o.accessToken.length < 24)) throw new Error('TCP cache requires a service access token');
    this.entries = new Map(); this.flights = new Map(); this.activeReaders = new Map();
    this.capacity = new Capacity(o.maxInflight, o.maxQueued);
    this.readCapacity = new Capacity(o.maxReaders, o.maxReaderQueue);
    this.regionCircuit = new Circuit(o); this.originCircuit = new Circuit(o);
    this.bytes = 0; this.reserved = 0; this.locked = false;
    this.stats = { hits: 0, misses: 0, coalesced: 0, upstreamRequests: 0, regionalRequests: 0, integrityFailures: 0, evictions: 0, rejected: 0 };
  }
  paths(key) { const dir = join(this.options.root, 'objects', key.slice(0, 2)); return { dir, bin: join(dir, `${key}.bin`), meta: join(dir, `${key}.json`) }; }
  async initialize() {
    await mkdir(this.options.root, { recursive: true, mode: 0o700 });
    await chmod(this.options.root, 0o700);
    const lockPath = join(this.options.root, '.owner');
    const claim = async () => { const file = await open(lockPath, 'wx', 0o600); await file.writeFile(String(process.pid)); await file.close(); };
    try { await claim(); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const old = Number((await readFile(lockPath, 'utf8').catch(() => '0')).trim());
      if (Number.isSafeInteger(old) && old > 0) {
        try { process.kill(old, 0); throw new Error('Cache directory already owned by a live process'); }
        catch (err) { if (err.code !== 'ESRCH') throw err; }
      }
      await rm(lockPath, { force: true }); await claim();
    }
    this.locked = true;
    if (this.options.socketPath) await rm(this.options.socketPath, { force: true });
    const root = join(this.options.root, 'objects');
    for (const shard of await readdir(root, { withFileTypes: true }).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error))) {
      if (!shard.isDirectory() || !/^[a-f0-9]{2}$/.test(shard.name)) continue;
      const folder = join(root, shard.name);
      const files = await readdir(folder, { withFileTypes: true });
      for (const file of files) {
        const path = join(folder, file.name);
        if (!file.isFile()) continue;
        if (file.name.includes('.part-')) { await rm(path, { force: true }); continue; }
        if (!/^[a-f0-9]{64}\.json$/.test(file.name)) continue;
        const key = file.name.slice(0, 64);
        const paths = this.paths(key);
        try {
          const meta = JSON.parse(await readFile(paths.meta, 'utf8'));
          const info = await stat(paths.bin);
          if (!ID.test(meta.id) || !REPOSITORY.test(meta.repositoryId) || key !== keyOf(meta.repositoryId, meta.id) || !KINDS.has(meta.kind) || info.size !== meta.size || info.size > this.options.maxObjectBytes) throw Error('Invalid persisted entry');
          this.entries.set(key, { ...meta, time: info.mtimeMs }); this.bytes += info.size;
        } catch { await Promise.all([rm(paths.meta, { force: true }), rm(paths.bin, { force: true })]); }
      }
      for (const file of files) if (file.isFile() && /^[a-f0-9]{64}\.bin$/.test(file.name) && !this.entries.has(file.name.slice(0, 64))) await rm(join(folder, file.name), { force: true });
    }
    await this.evictTo(0, 0);
  }
  async close() {
    if (this.server) await new Promise(resolve => this.server.close(resolve));
    if (this.locked) { await rm(join(this.options.root, '.owner'), { force: true }); this.locked = false; }
    if (this.options.socketPath) await rm(this.options.socketPath, { force: true });
  }
  async start() {
    await this.initialize();
    this.server = http.createServer((req, res) => { this.handle(req, res).catch(error => {
      if (!res.headersSent) json(res, error.status || 503, { error: error.status === 404 ? 'NOT_FOUND' : 'CACHE_UNAVAILABLE' }, { 'retry-after': '2' });
      else res.destroy();
    }); });
    try {
      await new Promise((resolve, reject) => {
        this.server.once('error', reject);
        if (this.options.socketPath) this.server.listen(this.options.socketPath, resolve);
        else this.server.listen(this.options.port, this.options.host || '127.0.0.1', resolve);
      });
      if (this.options.socketPath) await chmod(this.options.socketPath, 0o600);
    } catch (error) { await this.close(); throw error; }
    return this;
  }
  authorized(req) {
    if (!this.options.accessToken) return true;
    const provided = (req.headers.authorization || '').replace(/^Bearer /i, '');
    const a = Buffer.from(provided), b = Buffer.from(this.options.accessToken);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  async handle(req, res) {
    if (!this.authorized(req)) return json(res, 401, { error: 'UNAUTHORIZED' });
    if (req.method !== 'GET') return json(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    const url = new URL(req.url || '/', 'http://cache.internal');
    if (url.pathname === '/v1/status') return json(res, 200, { ...this.stats, entries: this.entries.size, bytes: this.bytes, reservedBytes: this.reserved, active: this.capacity.active, queued: this.capacity.waiters.length, originCircuitOpen: !this.originCircuit.ready(), regionalCircuitOpen: !this.regionCircuit.ready() });
    const match = /^\/v1\/objects\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (!match || !REPOSITORY.test(match[1]) || !ID.test(match[2])) return json(res, 400, { error: 'INVALID_OBJECT_REQUEST' });
    if (this.options.allowedRepositories && !this.options.allowedRepositories.includes(match[1])) return json(res, 403, { error: 'REPOSITORY_FORBIDDEN' });
    const release = await this.readCapacity.acquire().catch(error => { this.stats.rejected++; throw error; });
    try {
      const [ , repositoryId, id ] = match;
      const key = keyOf(repositoryId, id);
      let entry = this.entries.get(key);
      if (entry && !(await this.verified(key, entry))) { await this.remove(key); entry = null; this.stats.integrityFailures++; }
      if (entry) this.stats.hits++;
      else {
        this.stats.misses++;
        let flight = this.flights.get(key);
        if (flight) this.stats.coalesced++;
        else {
          flight = this.fill(key, repositoryId, id);
          this.flights.set(key, flight);
          void flight.finally(() => { this.flights.delete(key); }).catch(() => {});
        }
        entry = await flight;
      }
      this.activeReaders.set(key, (this.activeReaders.get(key) || 0) + 1);
      try {
        const path = this.paths(key).bin;
        if (!(await this.verified(key, entry))) { this.stats.integrityFailures++; await this.remove(key); throw Object.assign(new Error('Corrupt object'), { status: 503 }); }
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'x-devhub-object-kind': entry.kind, 'x-devhub-object-id': id, 'content-length': entry.size, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
        await pipeline(createReadStream(path), res);
        entry.time = Date.now(); await utimes(path, new Date(), new Date()).catch(() => {});
      } finally { const count = this.activeReaders.get(key) - 1; if (count) this.activeReaders.set(key, count); else this.activeReaders.delete(key); }
    } finally { release(); }
  }
  async verified(key, entry) {
    try {
      const info = await stat(this.paths(key).bin);
      if (info.size !== entry.size) return false;
      const hash = createHash('sha256').update(entry.kind).update('\0');
      for await (const chunk of createReadStream(this.paths(key).bin)) hash.update(chunk);
      return hash.digest('hex') === entry.id;
    } catch { return false; }
  }
  async remove(key) {
    const entry = this.entries.get(key); if (!entry) return;
    if (this.activeReaders.has(key)) return;
    this.entries.delete(key); this.bytes -= entry.size;
    const p = this.paths(key);
    await Promise.all([rm(p.meta, { force: true }), rm(p.bin, { force: true })]);
  }
  async evictTo(additionalBytes, additionalEntries) {
    while (this.bytes + this.reserved + additionalBytes > this.options.maxDiskBytes || this.entries.size + additionalEntries > this.options.maxEntries) {
      const victim = [...this.entries].filter(([k]) => !this.activeReaders.has(k) && !this.flights.has(k)).sort((a, b) => a[1].time - b[1].time)[0];
      if (!victim) throw Object.assign(new Error('Cache is full'), { status: 503 });
      await this.remove(victim[0]); this.stats.evictions++;
    }
  }
  async upstream(url, token, circuit, counter, assumedKind) {
    if (!circuit.ready()) throw Object.assign(new Error('Upstream circuit open'), { status: 503 });
    this.stats[counter]++;
    try {
      const response = await fetch(url, { headers: { accept: 'application/octet-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(this.options.timeoutMs) });
      if (response.status === 404) throw Object.assign(new Error('Object does not exist'), { status: 404, terminal: true });
      if (response.status === 413) { await response.body?.cancel(); throw Object.assign(new Error('Streaming required'), { status: 413, streamingRequired: true }); }
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`Upstream returned ${response.status}`); }
      const kind = assumedKind || response.headers.get('x-devhub-object-kind');
      if (!KINDS.has(kind)) throw new Error('Missing or invalid object kind');
      const size = Number(response.headers.get('content-length'));
      if (response.headers.get('content-length') && (!Number.isSafeInteger(size) || size > this.options.maxObjectBytes)) throw new Error('Oversized object');
      circuit.success();
      return { response, kind };
    } catch (error) { if (!error.terminal && !error.streamingRequired) circuit.failure(); throw error; }
  }
  async fill(key, repositoryId, id) {
    const release = await this.capacity.acquire().catch(error => { this.stats.rejected++; throw error; });
    let reserved = false;
    try {
      const existing = this.entries.get(key);
      if (existing && await this.verified(key, existing)) return existing;
      this.reserved += this.options.maxObjectBytes; reserved = true;
      await this.evictTo(0, 1);
      let upstream;
      const objectPath = `/v1/objects/${repositoryId}/${id}`;
      if (this.options.regionalUrl && this.regionCircuit.ready()) {
        try { upstream = await this.upstream(`${this.options.regionalUrl.replace(/\/$/, '')}${objectPath}`, this.options.regionalToken, this.regionCircuit, 'regionalRequests'); upstream.fromRegion = true; }
        catch (error) { if (error.terminal) throw error; }
      }
      if (!upstream) {
        const base = this.options.originUrl.replace(/\/$/, '');
        try {
          upstream = await this.upstream(`${base}/api/v2/repositories/${repositoryId}/objects/${id}?format=raw`, this.options.originToken, this.originCircuit, 'upstreamRequests');
        } catch (error) {
          if (!error.streamingRequired) throw error;
          // S3-backed immutable blobs use the authoritative streaming endpoint.
          upstream = await this.upstream(`${base}/api/v1/repositories/${repositoryId}/objects/${id}/content`, this.options.originToken, this.originCircuit, 'upstreamRequests', 'BLOB');
        }
      }
      const p = this.paths(key); await mkdir(p.dir, { recursive: true, mode: 0o700 });
      const nonce = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const tempBin = `${p.bin}.part-${nonce}`, tempMeta = `${p.meta}.part-${nonce}`;
      try {
        let size = 0;
        const hash = createHash('sha256').update(upstream.kind).update('\0');
        const check = new Transform({ transform: (chunk, _, callback) => {
          size += chunk.length;
          if (size > this.options.maxObjectBytes) return callback(new Error('Object exceeds cache size limit'));
          hash.update(chunk); callback(null, chunk);
        } });
        await pipeline(Readable.fromWeb(upstream.response.body), check, createWriteStream(tempBin, { flags: 'wx', mode: 0o600 }));
        if (hash.digest('hex') !== id) { this.stats.integrityFailures++; (upstream.fromRegion ? this.regionCircuit : this.originCircuit).failure(); throw new Error('Upstream content digest mismatch'); }
        const meta = { id, repositoryId, kind: upstream.kind, size };
        await writeFile(tempMeta, JSON.stringify(meta), { flag: 'wx', mode: 0o600 });
        await rename(tempBin, p.bin); await rename(tempMeta, p.meta);
        const entry = { ...meta, time: Date.now() };
        this.entries.set(key, entry); this.bytes += size;
        return entry;
      } finally { await Promise.all([rm(tempBin, { force: true }), rm(tempMeta, { force: true })]); }
    } finally { if (reserved) this.reserved -= this.options.maxObjectBytes; release(); }
  }
}

export async function startFromEnvironment() {
  const env = process.env;
  const cache = new ObjectCache({
    root: env.DEVHUB_CACHE_DIR,
    socketPath: env.DEVHUB_CACHE_SOCKET || undefined,
    port: env.DEVHUB_CACHE_PORT ? Number(env.DEVHUB_CACHE_PORT) : undefined,
    host: env.DEVHUB_CACHE_HOST,
    accessToken: env.DEVHUB_CACHE_ACCESS_TOKEN,
    originUrl: env.DEVHUB_ORIGIN_URL,
    originToken: env.DEVHUB_ORIGIN_TOKEN,
    regionalUrl: env.DEVHUB_REGIONAL_URL,
    regionalToken: env.DEVHUB_REGIONAL_TOKEN,
    maxDiskBytes: env.DEVHUB_CACHE_DISK_BYTES ? Number(env.DEVHUB_CACHE_DISK_BYTES) : undefined,
    maxObjectBytes: env.DEVHUB_CACHE_OBJECT_BYTES ? Number(env.DEVHUB_CACHE_OBJECT_BYTES) : undefined,
    allowedRepositories: env.DEVHUB_CACHE_REPOSITORIES?.split(',').filter(Boolean),
  });
  for (const key of ['maxDiskBytes', 'maxObjectBytes']) if (cache.options[key] === undefined) cache.options[key] = key === 'maxDiskBytes' ? 512 * 1024 * 1024 : 16 * 1024 * 1024;
  await cache.start();
  const shutdown = async () => { await cache.close(); process.exit(0); };
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
  return cache;
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  startFromEnvironment().catch(error => { console.error(error); process.exitCode = 1; });
}

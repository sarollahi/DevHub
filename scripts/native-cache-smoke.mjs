import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ObjectCache } from '../src/cache/daemon.mjs';

// Real native subprocesses, node cache, and authoritative mock.
const executable = process.env.DEVHUB_CLI;
if (!executable) throw new Error('DEVHUB_CLI required');
const dir = await mkdtemp(join(tmpdir(), 'devhub-native-cache-'));
const repository = randomUUID(), revision = 'a'.repeat(64);
const content = Buffer.from('on-demand verified workspace content\n');
const id = createHash('sha256').update('BLOB\0').update(content).digest('hex');
const token = 'native-client-credential-12345678901234567890';
const pipe = process.platform === 'win32'
  ? '\\\\.\\pipe\\devhub-' + process.pid + '-' + Date.now()
  : join(dir, 'devhub.sock');
let originReads = 0, permissionChecks = 0;
const origin = http.createServer((req, res) => {
  if (req.method === 'HEAD' && req.url.endsWith('/authorize')) {
    permissionChecks++;
    res.writeHead(req.headers.authorization === 'Bearer ' + token ? 204 : 403);
    res.end(); return;
  }
  if (req.url.endsWith('/refs')) {
    res.end(JSON.stringify({ records: [{ name: 'main', changesetId: revision, generation: 1 }] }));
    return;
  }
  if (req.url.includes('/tree?')) {
    res.end(JSON.stringify({ entries: [{ path: 'README.md', objectId: id, mode: '100644' }] }));
    return;
  }
  if (req.url.includes('/objects/' + id)) {
    originReads++;
    res.setHeader('content-type', 'application/octet-stream');
    res.setHeader('x-devhub-object-kind', 'BLOB');
    res.setHeader('content-length', content.length);
    res.end(content); return;
  }
  res.writeHead(404); res.end('{}');
});
const call = (cwd, args, extra = {}) => new Promise((done, reject) => {
  const child = spawn(resolve(executable), args, {
    cwd, env: { ...process.env, DEVHUB_TOKEN: token, DEVHUB_CACHE_SOCKET: pipe, ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errors = '';
  child.stderr.on('data', data => { errors += data.toString(); });
  child.stdout.resume();
  child.once('error', reject);
  child.once('exit', code => code === 0 ? done() : reject(new Error(args.join(' ') + ': ' + errors)));
});
let cache;
try {
  await new Promise(done => origin.listen(0, '127.0.0.1', done));
  const base = 'http://127.0.0.1:' + origin.address().port;
  cache = new ObjectCache({
    root: join(dir, 'cache'), socketPath: pipe, originUrl: base, originToken: token,
    requireClientAuthorization: true, allowedRepositories: [repository],
  });
  await cache.start();
  for (const name of ['developer', 'ci']) {
    const cwd = join(dir, name); await mkdir(cwd);
    await call(cwd, ['init', '--server', base, '--repository', repository]);
    await call(cwd, ['select', '--file', 'README.md']);
    await call(cwd, ['sync']);
    await call(cwd, ['hydrate', 'README.md']);
    assert.deepEqual(await readFile(join(cwd, 'README.md')), content);
  }
  assert.equal(originReads, 1, 'two independent clients share one upstream object');
  assert.equal(permissionChecks, 2, 'each client authorization checked independently');
  assert.equal(cache.stats.hits, 1, 'second client uses warmed node cache');
  console.log(JSON.stringify({ platform: process.platform, nativeClients: 2, originReads,
    warmHits: cache.stats.hits, permissionChecks, result: 'pass' }));
} finally {
  if (cache) await cache.close();
  if (origin.listening) await new Promise(done => origin.close(done));
  await rm(dir, { force: true, recursive: true });
}

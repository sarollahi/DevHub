import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObjectCache } from "../src/cache/daemon.mjs";
import { getCachedObject } from "../src/cache/client.mjs";

async function listen(server) {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return "http://127.0.0.1:" + server.address().port;
}
function item(text) {
  const data = Buffer.from(text);
  return { data, id: createHash("sha256").update("BLOB\0").update(data).digest("hex") };
}
test("regional TCP partition, bounded coalescing, recovery and persistent workspace bytes", { timeout: 20000 }, async t => {
  const repo = randomUUID(), first = item("partitioned-immutable-a"), second = item("recovered-immutable-b");
  const items = new Map([[first.id, first], [second.id, second]]);
  let partitioned = true, regionCalls = 0, originCalls = 0;
  const source = http.createServer((req, res) => {
    originCalls++;
    const id = /[a-f0-9]{64}/.exec(req.url || "")?.[0];
    const entry = items.get(id);
    if (!entry) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "x-devhub-object-kind": "BLOB" }); res.end(entry.data);
  });
  const region = http.createServer((req, res) => {
    regionCalls++;
    if (partitioned) { req.socket.destroy(); return; }
    const id = /[a-f0-9]{64}/.exec(req.url || "")?.[0];
    const entry = items.get(id);
    if (!entry) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "x-devhub-object-kind": "BLOB" }); res.end(entry.data);
  });
  const originUrl = await listen(source), regionalUrl = await listen(region);
  const directory = await mkdtemp(join(tmpdir(), "devhub-partition-"));
  const options = { root: join(directory, "cache"), socketPath: join(directory, "cache.sock"),
    originUrl, regionalUrl, timeoutMs: 1000, maxDiskBytes: 32768, maxObjectBytes: 1024,
    maxInflight: 2, maxQueued: 64, maxReaders: 64, maxReaderQueue: 64 };
  let cache = new ObjectCache(options);
  t.after(async () => {
    if (cache) await cache.close();
    await Promise.all([new Promise(resolve => source.close(resolve)), new Promise(resolve => region.close(resolve))]);
    await rm(directory, { recursive: true, force: true });
  });
  await cache.start();
  const objects = await Promise.all(Array.from({ length: 30 }, () =>
    getCachedObject({ socketPath: options.socketPath, repositoryId: repo, id: first.id })));
  assert.ok(objects.every(x => x.data.equals(first.data)));
  assert.equal(originCalls, 1, "regional connection failures should create only one origin fetch");
  assert.equal(regionCalls, 1, "30 workers coalesce the failed regional fetch");
  assert.ok(cache.stats.coalesced > 0);
  partitioned = false;
  const restored = await getCachedObject({ socketPath: options.socketPath, repositoryId: repo, id: second.id });
  assert.deepEqual(restored.data, second.data);
  assert.equal(originCalls, 1, "healed regional cache should serve subsequent misses");
  const originBeforeRestart = originCalls;
  await cache.close();
  cache = new ObjectCache(options);
  await cache.start();
  const durable = await getCachedObject({ socketPath: options.socketPath, repositoryId: repo, id: first.id });
  assert.deepEqual(durable.data, first.data);
  assert.equal(originCalls, originBeforeRestart, "restart must not fetch a healthy cached object");
});

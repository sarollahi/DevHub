import http from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { ObjectCache } from "../cache/daemon.mjs";
import { materializeCachedObject } from "../cache/client.mjs";
import { getObject } from "../source-control/service";
import type { SourceActor } from "../source-control/contracts";

type Entry = { path: string; objectId: string; mode?: string };
export async function benchmarkWorkspaces(repositoryId: string, actor: SourceActor, entries: Entry[]) {
  const paths = entries.filter(e => e.path.startsWith("packages/"));
  if (!paths.length) return { skipped: "No monorepo paths" };
  const selected = paths.filter((_, i) => i % 10 === 0);
  const misses = paths.filter((_, i) => i % 10 === 1);
  const dir = await mkdtemp(join(tmpdir(), "devhub-real-workspace-"));
  const socketPath = join(dir, "cache.sock");
  const originCounters = { requests: 0, bytes: 0, failures: 0 };
  const origin = http.createServer((request, response) => {
    void (async () => {
      const match = /^\/api\/v2\/repositories\/([0-9a-f-]{36})\/objects\/([a-f0-9]{64})/.exec(request.url || "");
      if (!match || match[1] !== repositoryId) { response.writeHead(404); response.end(); return; }
      try {
        const obj = await getObject(repositoryId, match[2], actor);
        const bytes = Buffer.from(obj.dataBase64, "base64");
        originCounters.requests++;
        originCounters.bytes += bytes.byteLength;
        response.writeHead(200, { "x-devhub-object-kind": obj.kind,
          "content-type": "application/octet-stream", "content-length": bytes.byteLength });
        response.end(bytes);
      } catch { originCounters.failures++; response.writeHead(503); response.end(); }
    })();
  });
  let cache: InstanceType<typeof ObjectCache> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      origin.once("error", reject); origin.listen(0, "127.0.0.1", resolve);
    });
    const address = origin.address();
    if (!address || typeof address === "string") throw new Error("Origin address unavailable");
    const options = { root: join(dir, "cache"), socketPath, originUrl: "http://127.0.0.1:" + address.port,
      maxDiskBytes: 64 * 1024 * 1024, maxObjectBytes: 2 * 1024 * 1024, maxInflight: 8, maxQueued: 128,
      maxReaders: 64, maxReaderQueue: 256 };
    cache = new ObjectCache(options);
    await cache.start();
    const results: { scenario: string; files: number; jobs: number; milliseconds: number;
      originRequests: number; originBytes: number; cacheHits: number; cacheMisses: number }[] = [];
    async function scenario(name: string, list: Entry[], jobs: number) {
      const start = performance.now();
      const priorRequests = originCounters.requests, priorBytes = originCounters.bytes;
      const hits = cache!.stats.hits, missesBefore = cache!.stats.misses;
      await Promise.all(Array.from({ length: jobs }, async (_, j) => {
        const workspace = join(dir, name + "-" + j);
        for (const item of list) {
          const destination = join(workspace, item.path);
          await mkdir(dirname(destination), { recursive: true });
          await materializeCachedObject({ socketPath, repositoryId, id: item.objectId }, destination);
        }
      }));
      results.push({ scenario: name, files: list.length * jobs, jobs,
        milliseconds: Number((performance.now() - start).toFixed(2)),
        originRequests: originCounters.requests - priorRequests,
        originBytes: originCounters.bytes - priorBytes,
        cacheHits: cache!.stats.hits - hits, cacheMisses: cache!.stats.misses - missesBefore });
    }
    await scenario("cold-sparse", selected, 4);
    await scenario("warm-sparse", selected, 4);
    await scenario("cold-other-paths", misses, 1);
    const beforeRestart = originCounters.requests;
    await cache.close();
    cache = undefined;
    cache = new ObjectCache(options);
    await cache.start();
    await scenario("restart-warm-sparse", selected, 1);
    if (originCounters.requests !== beforeRestart)
      throw new Error("Persistent cache failed warm restart integrity/retention check");
    if (originCounters.failures > 0) throw new Error("Actual native object origin failed");
    return { selectedPaths: selected.length, monorepoFiles: paths.length, results, originCounters,
      caveat: "Workspaces use native persisted blobs and source-control snapshots through the shared cache daemon" };
  } finally {
    if (cache) await cache.close();
    if (origin.listening) await new Promise<void>(resolve => origin.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}

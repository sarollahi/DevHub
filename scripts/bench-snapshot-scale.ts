/**
 * Real DB + object-store scale harness. It makes no simulated success claims.
 *
 * BENCH_REPOSITORY_ID, BENCH_ACTOR_ID, BENCH_CREDENTIAL_ID and BENCH_OBJECT_ID
 * must belong to one authorized, disposable repository.
 *
 * Example: npm run bench:snapshot-scale -- --paths=100000 --depth=100000
 * Resume:  --paths=0 --depth=100000 --start=8000 --parent=<last-completed-id>
 * A million-change run is deliberately opt-in: --depth=1000000
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { db } from "../src/lib/prisma";
import { createCanonicalChangeset, getCanonicalSnapshotPage } from "../src/source-control/canonical";
import { SnapshotTree } from "../src/source-control/snapshot-tree";

const flags = new Map(process.argv.slice(2).map(arg => {
  const [name, ...value] = arg.replace(/^--/, "").split("=");
  return [name, value.join("=")];
}));
const integer = (name: string, fallback: number) => {
  const value = Number(flags.get(name) ?? fallback);
  if (!Number.isSafeInteger(value) || value < 0) throw Error("Invalid --" + name);
  return value;
};
const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw Error(name + " must be set");
  return value;
};
const repoId = env("BENCH_REPOSITORY_ID");
const blobId = env("BENCH_OBJECT_ID");
const actor = { type: "AGENT" as const, id: env("BENCH_ACTOR_ID"), credentialId: env("BENCH_CREDENTIAL_ID") };
const paths = integer("paths", 0);
const depth = integer("depth", 100000);
const start = integer("start", 0);
const progressEvery = Math.max(1, integer("progress-every", 250));
const report = flags.get("report") || "snapshot-scale-results.jsonl";
const quantiles = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, p50: sorted[Math.floor(sorted.length * .5)],
    p95: sorted[Math.floor(sorted.length * .95)], p99: sorted[Math.floor(sorted.length * .99)] };
};
const sample: number[] = [];
let seed = 1771;
const random = () => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 2 ** 32; };
function takeSample(value: number, n: number) {
  if (sample.length < 2048) sample.push(value);
  else { const idx = Math.floor(random() * n); if (idx < sample.length) sample[idx] = value; }
}
const checks: string[] = [];
let parent = flags.get("parent");
if (start && !parent) throw Error("Resume requires --parent (last completed revision ID)");
if (start > depth) throw Error("Start cannot exceed depth");

const begin = performance.now();
const cpuBegin = process.cpuUsage();
const nodesBefore = await db.sourceSnapshotNode.count();
let peakRss = process.memoryUsage().rss;
let operations = 0;
const elapsed = () => Number((performance.now() - begin).toFixed(2));
const record = (payload: object) => appendFileSync(report, JSON.stringify({
  timestamp: new Date().toISOString(), ...payload,
}) + "\n", "utf8");

try {
  if (!parent) {
    const root = await createCanonicalChangeset(repoId, actor, {
      apiVersion: 2, parents: [], description: "scale fixture initial",
      operations: [{ kind: "ADD", path: "scale/active.txt", objectId: blobId }],
    });
    parent = root.id;
    record({ phase: "initial", revision: parent });
  }

  // Incremental file population; one persisted root per batch. No process holds
  // a whole repository manifest. Large fixture creation is never described as
  // completed unless all batches return successfully.
  if (paths) {
    const base = await getCanonicalSnapshotPage(repoId, parent, actor, 1);
    if (!base.entries.length) throw Error("Parent revision has no readable tree");
    for (let offset = 0; offset < paths; offset += 4000) {
      const operationsBatch = Array.from({ length: Math.min(4000, paths - offset) }, (_, i) => ({
        kind: "ADD" as const, path: "scale/files/" + String(offset + i).padStart(10, "0"), objectId: blobId,
      }));
      const revision = await createCanonicalChangeset(repoId, actor, {
        apiVersion: 2, parents: [parent], description: "scale populate " + offset,
        operations: operationsBatch,
      });
      parent = revision.id;
      operations += operationsBatch.length;
      if ((offset / 4000) % 10 === 0) record({ phase: "paths", inserted: offset + operationsBatch.length,
        requested: paths, revision: parent, elapsedMs: elapsed() });
    }
  }

  const queryTimes: number[] = [];
  for (let i = start; i < depth; i++) {
    const tick = performance.now();
    const revision = await createCanonicalChangeset(repoId, actor, {
      apiVersion: 2, parents: [parent], description: "deep revision " + i,
      operations: [{ kind: "MODIFY", path: "scale/active.txt", objectId: blobId }],
    });
    const latency = performance.now() - tick;
    parent = revision.id;
    operations++;
    takeSample(latency, i - start + 1);
    // Reservoir over actual published revisions, not mock history.
    if (checks.length < 32) checks.push(parent);
    else { const idx = Math.floor(random() * (i - start + 1)); if (idx < checks.length) checks[idx] = parent; }
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    if ((i + 1) % progressEvery === 0 || i + 1 === depth) {
      const queryStart = performance.now();
      const page = await getCanonicalSnapshotPage(repoId, checks[Math.floor(random() * checks.length)], actor, 64);
      queryTimes.push(performance.now() - queryStart);
      if (!page.entries.length) throw Error("Random revision cannot be read");
      record({ phase: "history", completed: i + 1, requested: depth, revision: parent,
        elapsedMs: elapsed(), peakRssBytes: peakRss, latencyMsSample: quantiles(sample),
        randomRevisionReadMs: queryTimes.at(-1) });
    }
  }
  const root = await db.sourceSnapshotRoot.findUniqueOrThrow({ where: { changesetId: parent } });
  const tree = new SnapshotTree(db);
  const fileCount = await tree.count(root.rootId);
  const nodesAfter = await db.sourceSnapshotNode.count();
  const cpu = process.cpuUsage(cpuBegin);
  const finish = { phase: "complete", completed: depth, requested: depth, rootId: root.rootId,
    revision: parent, fileCount, modifiedOperations: operations, elapsedMs: elapsed(),
    latencyMsReservoir: quantiles(sample), randomReadMs: quantiles(queryTimes),
    peakRssBytes: peakRss, processCpuUserUs: cpu.user, processCpuSystemUs: cpu.system,
    persistedNodeDelta: nodesAfter - nodesBefore,
    dbStatementCount: null, databaseCpuUs: null, physicalWalBytes: null,
    note: "Actual repository writes and reads. Reservoir latencies are approximate; DB totals require pg_stat_statements/WAL." };
  record(finish);
  process.stdout.write(JSON.stringify(finish, null, 2) + "\n");
} catch (error) {
  record({ phase: "failed", revision: parent, elapsedMs: elapsed(),
    message: error instanceof Error ? error.message : String(error) });
  throw error;
} finally {
  await db.$disconnect();
}

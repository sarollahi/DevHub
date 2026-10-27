/**
 * Reproducible publication microbenchmark against an isolated deployed database.
 *
 * BENCH_PUBLICATION_CASES is a JSON array:
 * [{ "label":"1000/shallow", "repositoryId":"...", "parentId":"...",
 *    "expectedFiles":1000, "editPath":"bench/edit.txt", "expectedHistory":"shallow" }]
 * BENCH_ACTOR_ID and BENCH_CREDENTIAL_ID identify an authorized agent.
 * BENCH_SAMPLES defaults to 30; BENCH_CONCURRENCY defaults to 1.
 *
 * Paths must exist in the selected immutable parent. Never count migration,
 * object staging, or fixture setup as one-file publication latency.
 */
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { writeFile } from "node:fs/promises";
import { db } from "../src/lib/prisma";
import { stageCanonicalBlob, createCanonicalChangeset } from "../src/source-control/canonical";
import { SnapshotTree } from "../src/source-control/snapshot-tree";
import type { SourceActor } from "../src/source-control/contracts";

type Case = { label: string; repositoryId: string; parentId: string; expectedFiles: number;
  editPath: string; expectedHistory?: "shallow" | "deep" };
type Sample = { ms: number; cpuUserUs: number; cpuSystemUs: number; rssPeak: number;
  nodeReads: number; nodeWrites: number; nodeBytes: number; nodeCount: number };
const percentile = (a: number[], p: number) => {
  const values = [...a].sort((x, y) => x - y);
  return values[Math.ceil(p / 100 * values.length) - 1] ?? null;
};
const value = (key: string) => {
  const raw = process.env[key];
  if (!raw) throw new Error("Missing " + key);
  return raw;
};
async function depth(repositoryId: string, head: string) {
  let current: string | undefined = head;
  let n = 0;
  const visited = new Set<string>();
  while (current) {
    if (visited.has(current) || n > 100000) throw new Error("Cycle or excessive first-parent ancestry");
    visited.add(current);
    const record: { parentId: string } | null = await db.sourceChangesetParent.findFirst({
      where: { changesetId: current, child: { repositoryId }, position: 0 },
      select: { parentId: true },
    });
    n++;
    current = record?.parentId;
  }
  return n;
}

async function main() {
  const cases = JSON.parse(value("BENCH_PUBLICATION_CASES")) as Case[];
  if (!Array.isArray(cases) || !cases.length) throw new Error("At least one fixture case is required");
  const iterations = Number(process.env.BENCH_SAMPLES ?? "30");
  const concurrency = Number(process.env.BENCH_CONCURRENCY ?? "1");
  if (!Number.isSafeInteger(iterations) || iterations < 3 || iterations > 1000
    || !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 1000) throw new Error("Invalid sample count/concurrency");
  const actor: SourceActor = { type: "AGENT", id: value("BENCH_ACTOR_ID"),
    credentialId: value("BENCH_CREDENTIAL_ID") };
  const results = [];
  for (const spec of cases) {
    if (!spec.label || !Number.isSafeInteger(spec.expectedFiles) || spec.expectedFiles < 1) throw new Error("Malformed fixture");
    const meta = await db.$transaction(async tx => {
      const change = await tx.sourceChangeset.findFirst({ where: {
        repositoryId: spec.repositoryId, id: spec.parentId,
      }, select: { id: true } });
      if (!change) throw new Error("Missing fixture parent");
      const root = await tx.sourceSnapshotRoot.findFirst({ where: {
        changesetId: spec.parentId, repositoryId: spec.repositoryId,
      }, select: { rootId: true } });
      if (!root) throw new Error("Parent has not been materialized; run migration before benchmarking");
      const tree = new SnapshotTree(tx);
      const count = await tree.count(root.rootId);
      const original = await tree.get(root.rootId, spec.editPath);
      if (!original || count !== spec.expectedFiles) throw new Error("Fixture size or edit target differs from specification");
      return { count, rootId: root.rootId };
    });
    const parentDepth = await depth(spec.repositoryId, spec.parentId);
    if (spec.expectedHistory === "shallow" && parentDepth > 10
      || spec.expectedHistory === "deep" && parentDepth < 1000) {
      throw new Error("Fixture history depth does not match its declared category");
    }
    const staged = await stageCanonicalBlob(spec.repositoryId, actor,
      Buffer.from("publication-benchmark:" + randomUUID()).toString("base64"));
    const nonce = randomUUID();
    const samples: Sample[] = [];
    let index = 0;
    // All changesets branch independently from the exact same immutable root.
    // Avoid a moving-ref lock, and preserve isolated latency measurements.
    while (index < iterations) {
      const batch = Array.from({ length: Math.min(concurrency, iterations - index) }, (_, i) => index + i);
      const measured = await Promise.all(batch.map(async number => {
        const cpuBefore = process.cpuUsage();
        const begin = performance.now();
        const receipt = await createCanonicalChangeset(spec.repositoryId, actor, {
          apiVersion: 2, description: "publication benchmark " + nonce + "/" + number,
          parents: [spec.parentId], operations: [{ kind: "MODIFY", path: spec.editPath, objectId: staged.id }],
        });
        const ms = performance.now() - begin;
        const cpu = process.cpuUsage(cpuBefore);
        // Audit payload is written atomically with the changeset.
        const audit = await db.auditEvent.findFirst({ where: {
          repositoryId: spec.repositoryId, action: "changeset.published", subjectId: receipt.id,
        }, select: { metadata: true } });
        const stats = (audit?.metadata as { snapshotStats?: {
          nodeReadQueries: number; nodeWriteQueries: number; newNodeCount: number; newNodeBytes: number;
        } } | null)?.snapshotStats;
        if (!stats) throw new Error("Missing server-side publication metrics");
        return { ms, cpuUserUs: cpu.user, cpuSystemUs: cpu.system, rssPeak: process.memoryUsage().rss,
          nodeReads: stats.nodeReadQueries, nodeWrites: stats.nodeWriteQueries,
          nodeBytes: stats.newNodeBytes, nodeCount: stats.newNodeCount };
      }));
      samples.push(...measured);
      index += batch.length;
    }
    results.push({ label: spec.label, expectedFiles: spec.expectedFiles, observedFiles: meta.count,
      parentDepth, rootId: meta.rootId, samples: samples.length, concurrency,
      latencyMs: { p50: percentile(samples.map(s => s.ms), 50),
        p95: percentile(samples.map(s => s.ms), 95), p99: percentile(samples.map(s => s.ms), 99) },
      totalCpuUserUs: samples.reduce((n, s) => n + s.cpuUserUs, 0),
      totalCpuSystemUs: samples.reduce((n, s) => n + s.cpuSystemUs, 0),
      peakRssBytes: Math.max(...samples.map(s => s.rssPeak)),
      treeNodeReadQueries: { p50: percentile(samples.map(s => s.nodeReads), 50),
        p95: percentile(samples.map(s => s.nodeReads), 95) },
      treeNodeWriteQueries: { p50: percentile(samples.map(s => s.nodeWrites), 50),
        p95: percentile(samples.map(s => s.nodeWrites), 95) },
      actualNodePayloadBytes: samples.reduce((n, s) => n + s.nodeBytes, 0),
      actualNewNodes: samples.reduce((n, s) => n + s.nodeCount, 0),
      totalDbQueryCount: null, totalWalBytes: null,
      note: "Node query counts exclude authorization, audit and other SQL. Payload bytes exclude indexes, WAL and transaction overhead.",
    });
  }
  const report = { version: 1, measuredAt: new Date().toISOString(),
    topology: process.env.BENCH_TOPOLOGY || "not-specified",
    nodeVersion: process.version, cases: results,
    caveats: ["Requires a dedicated PostgreSQL benchmark fixture and deployed object storage",
      "Elapsed time includes authorization and publication, not staging or legacy migration",
      "Complete SQL query counts and WAL bytes require external database tracing",
      "CPU and peak RSS are process-wide under concurrent load"] };
  const output = JSON.stringify(report, null, 2);
  if (process.env.BENCH_REPORT_PATH) await writeFile(process.env.BENCH_REPORT_PATH, output);
  process.stdout.write(output + "\n");
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => db.$disconnect());

import { performance } from "node:perf_hooks";
import { db } from "../src/lib/prisma";
import { enqueueDerived, processDerivedBatch, readDerived } from "../src/source-control/derived-index";
import { indexedFileHistory, indexedLinearAncestry, indexedLinearMergeBases } from "../src/source-control/derived-queries";

// Only real persisted changesets/revisions are measured. The fixture population
// is delegated to bench:snapshot-scale. Missing telemetry is reported as null.
const arg = (name: string, fallback?: string) =>
  process.argv.find(v => v.startsWith("--" + name + "="))?.split("=").slice(1).join("=") || fallback;
const repositoryId = arg("repository", process.env.BENCH_REPOSITORY_ID);
const revision = arg("revision", process.env.BENCH_REVISION);
const path = arg("path", process.env.BENCH_PATH || "README.md")!;
const limit = Math.max(1, Math.min(200, Number(arg("limit", "50"))));
const samples = Math.max(1, Math.min(5000, Number(arg("samples", "100"))));
const passes = Math.max(1, Math.min(100000, Number(arg("passes", "1000"))));
const quantiles = (values: number[]) => {
  if (!values.length) return { p50: null, p95: null, p99: null };
  const ordered = [...values].sort((a, b) => a - b);
  return { p50: ordered[Math.ceil(.50 * ordered.length) - 1],
    p95: ordered[Math.ceil(.95 * ordered.length) - 1],
    p99: ordered[Math.ceil(.99 * ordered.length) - 1] };
};
async function measure<T>(fn: () => Promise<T>, count: number) {
  const samplesMs: number[] = [];
  let last: T | undefined;
  for (let i = 0; i < count; i++) {
    const start = performance.now();
    last = await fn();
    samplesMs.push(performance.now() - start);
  }
  return { count, ms: quantiles(samplesMs), last };
}
async function main() {
  if (!repositoryId || !revision) throw new Error("Specify --repository and --revision from a disposable fixture");
  const source = await db.sourceChangeset.findFirst({ where: { repositoryId, id: revision }, select: { id: true } });
  if (!source) throw new Error("Revision not in repository");
  const revisionCount = await db.sourceChangeset.count({ where: { repositoryId } });
  const indexKinds = ["ancestry", "history", "changed-paths", "impact", "directory"] as const;
  const coldStart = performance.now();
  const before = await Promise.all(indexKinds.map(kind => readDerived(repositoryId, revision, kind)));
  await enqueueDerived(repositoryId, revision, indexKinds);
  let completed = 0; let inspected = 0; let elapsedPasses = 0;
  for (; elapsedPasses < passes; elapsedPasses++) {
    const progress = await processDerivedBatch(64);
    completed += progress.completed;
    inspected += progress.inspected;
    if (await readDerived(repositoryId, revision, "history")) break;
    if (!progress.inspected) break;
  }
  const coldMs = performance.now() - coldStart;
  const warm = !!(await readDerived(repositoryId, revision, "history"));
  const ancestry = warm ? await measure(() => indexedLinearAncestry(repositoryId, revision, limit), samples) : null;
  const history = warm ? await measure(() => indexedFileHistory(repositoryId, revision, path, true, limit), samples) : null;
  const bases = warm ? await measure(() => indexedLinearMergeBases(repositoryId, revision, revision), samples) : null;
  const tables = ["SourceDerivedIndex", "SourceDerivedJump", "SourceDerivedPathEvent", "SourceDerivedBlameFile"];
  const storage: Record<string, { tableBytes: number; indexBytes: number; rows: number }> = {};
  for (const name of tables) {
    const stats = await db.$queryRawUnsafe<Array<{ table_bytes: bigint; index_bytes: bigint; rows: bigint }>>(
      `SELECT pg_table_size('"${name}"') AS table_bytes, pg_indexes_size('"${name}"') AS index_bytes,
        (SELECT count(*) FROM "${name}" WHERE "repositoryId" = $1::uuid) AS rows`, repositoryId);
    storage[name] = { tableBytes: Number(stats[0].table_bytes), indexBytes: Number(stats[0].index_bytes),
      rows: Number(stats[0].rows) };
  }
  const report = {
    repositoryId, revision, revisionCount, sampleCount: samples, queryLimit: limit,
    coldAlreadyIndexed: before.map((value, i) => ({ kind: indexKinds[i], present: value !== null })),
    completed: warm, backfill: { measuredWallMs: coldMs, passes: elapsedPasses + 1, inspected, completedJobs: completed,
      jobsPerSecond: coldMs > 0 ? completed / (coldMs / 1000) : null },
    warmQueryLatencyMs: { ancestry: ancestry?.ms ?? null, history: history?.ms ?? null,
      mergeBase: bases?.ms ?? null },
    querySupported: { ancestry: !!ancestry?.last, history: !!history?.last,
      mergeBase: !!bases?.last },
    storage, storageOverheadBytes: Object.values(storage).reduce((sum, v) => sum + v.tableBytes + v.indexBytes, 0),
    cacheHitRatio: null, recoveryDurationMs: null,
    notes: "Actual PostgreSQL fixture. Production network/storage/runner topology and crash timing are not inferred.",
  };
  console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => db.$disconnect());

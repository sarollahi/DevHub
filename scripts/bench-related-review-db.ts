import { createHash, randomBytes } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { db } from "../src/lib/prisma";
import { indexSignals, subsystem } from "../src/review/index-algorithms";
import { discoverRelated } from "../src/review/related-index";
import { stageCanonicalBlob, createCanonicalChangeset } from "../src/source-control/canonical";
import { processReview } from "../src/review/source-review";
import { testSession } from "../tests/support/identities";
import type { NativeAssessment, Region } from "../src/review/analysis";

const option = (name: string, fallback: string) =>
  process.argv.find(v => v.startsWith("--" + name + "="))?.slice(name.length + 3) ?? fallback;
const total = Number(option("count", "1000"));
const workerCount = Number(option("workers", "32"));
const concurrency = Number(option("concurrency", "4"));
const output = option("output", "reports/review-db-" + total + ".json");
if (![1000, 10000, 100000].includes(total)) throw new Error("--count must be 1000, 10000 or 100000");
if (!Number.isSafeInteger(workerCount) || workerCount < 0 || workerCount > 2000 ||
  !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error("Invalid worker settings");
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const uuidSuffix = randomBytes(7).toString("hex");
const vector = (mode: "similar" | "different") =>
  Array.from({ length: 64 }, (_, i) => mode === "similar" ? Math.sin(i * .31) : Math.cos(i * .73));
const category = (i: number) =>
  i === total - 1 ? "EXACT" : i === total - 2 ? "EQUIVALENT" :
  i === total - 3 ? "CONFLICT" : i === total - 4 ? "INDEPENDENT" :
  i === total - 5 ? "SEMANTIC" : "NORMAL";
function row(i: number) {
  const role = category(i);
  const linked = role === "EXACT" ? 0 : role === "EQUIVALENT" ? 1 :
    role === "CONFLICT" ? 2 : role === "INDEPENDENT" ? 4 :
      role === "SEMANTIC" ? 3 : i;
  const path = linked === 0 ? "cases/exact.ts" : linked === 1 ? "cases/equivalent.ts" :
    linked === 2 ? "cases/conflict.ts" : linked === 4 ? "cases/independent.ts" :
    linked === 3 ? (role === "SEMANTIC" ? "features/other-implementation.ts" : "library/primary-implementation.ts") :
    "src/module-" + (i % 512) + "/file-" + (i % 37) + ".ts";
  const start = role === "INDEPENDENT" ? 50 : linked === 4 ? 5 : linked === 2 ? 9 : (i % 350) + 1;
  const fingerprint = digest("fingerprint-" + (role === "EXACT" ? 0 : i));
  const equivalenceHash = digest("equivalent-" + (role === "EQUIVALENT" ? 1 : i));
  const baseObject = digest("base-" + linked);
  const embedding = linked === 3 && (role === "SEMANTIC" || i === 3) ? vector("similar") : null;
  const region: Region = { path, start, end: start + 1, baseObject, binary: false };
  const assessment: NativeAssessment = { fingerprint, paths: [path], regions: [region],
    findings: [], riskScore: path.includes("auth/") ? 65 : 0, riskTier: "LOW",
    summary: "Seeded immutable index metadata", groupKey: digest(subsystem(path)).slice(0, 32), excerpt: "" };
  const description = "WORK-" + (i % 2048) + " proposed " + i;
  const id = digest("review-db:" + uuidSuffix + ":" + i);
  const signals = indexSignals({ assessment, equivalenceHash,
    contentHash: digest("content-" + i), description, embedding, vectorNamespace: "fixture:64" });
  return { id, description, assessment, equivalenceHash, signals, embedding };
}
function quantile(xs: number[]) {
  if (!xs.length) return { p50: null, p95: null, p99: null };
  const sorted = [...xs].sort((a, b) => a - b);
  return { p50: sorted[Math.ceil(xs.length * .5) - 1],
    p95: sorted[Math.ceil(xs.length * .95) - 1],
    p99: sorted[Math.ceil(xs.length * .99) - 1] };
}
async function storedSizes() {
  const names = ["SourceChangeset", "SourceReview", "SourceReviewSignal", "SourceReviewRegion"];
  const measurements: Record<string, { tableBytes: number; indexBytes: number; totalBytes: number }> = {};
  for (const name of names) {
    // Hardcoded identifiers only; no untrusted identifier interpolation.
    const result = await db.$queryRawUnsafe<Array<{ table_bytes: bigint; index_bytes: bigint; total_bytes: bigint }>>(
      'SELECT pg_table_size(\'"' + name + '"\') AS table_bytes, ' +
      'pg_indexes_size(\'"' + name + '"\') AS index_bytes, ' +
      'pg_total_relation_size(\'"' + name + '"\') AS total_bytes');
    measurements[name] = {
      tableBytes: Number(result[0].table_bytes),
      indexBytes: Number(result[0].index_bytes),
      totalBytes: Number(result[0].total_bytes),
    };
  }
  return measurements;
}
async function measureWorkerThroughput() {
  if (!workerCount) return null;
  // Real canonical publication and real source-review worker analysis:
  // no synthetic completed-state shortcut is used in this measurement.
  const owner = await db.user.create({ data: {
    handle: "worker-" + uuidSuffix, email: "worker-" + uuidSuffix + "@example.invalid",
  } });
  const repository = await db.repository.create({ data: {
    ownerId: owner.id, slug: "worker-" + uuidSuffix, name: "Review worker throughput",
  } });
  const actor = (await testSession(owner.id)).actor;
  const stage = async (text: string) => (await stageCanonicalBlob(repository.id, actor,
    Buffer.from(text).toString("base64"))).id;
  const rootObject = await stage("root\n");
  const root = await createCanonicalChangeset(repository.id, actor, {
    apiVersion: 2, description: "benchmark root", parents: [],
    operations: [{ kind: "ADD", path: "README.md", objectId: rootObject }],
  });
  const queue: string[] = [];
  for (let i = 0; i < workerCount; i++) {
    const id = await stage("export const value = " + i + ";\n");
    const change = await createCanonicalChangeset(repository.id, actor, {
      apiVersion: 2, description: "benchmark-worker-" + i, parents: [root.id],
      operations: [{ kind: "ADD", path: "src/job-" + i + ".ts", objectId: id }],
    });
    queue.push(change.id);
  }
  const start = performance.now();
  const latencies: number[] = [];
  let successes = 0, failures = 0, cursor = 0;
  const threads = Array.from({ length: concurrency }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= queue.length) break;
      const id = queue[index];
      const lease = new Date(Date.now() + 120_000);
      const claimed = await db.sourceReview.updateMany({
        where: { repositoryId: repository.id, changesetId: id, state: "QUEUED" },
        data: { state: "RUNNING", leaseUntil: lease, attempts: 1 },
      });
      if (claimed.count !== 1) throw new Error("Review worker lease was not claimed");
      const began = performance.now();
      try {
        await processReview(id, lease, 1);
        const actual = await db.sourceReview.findUniqueOrThrow({ where: { changesetId: id },
          select: { state: true, indexedAt: true, error: true } });
        if (actual.state !== "COMPLETED" || !actual.indexedAt) throw new Error("Worker did not commit its index");
        successes++;
        latencies.push(performance.now() - began);
      } catch (error) {
        failures++;
        console.error("Worker fixture failed", id, error);
      }
    }
  });
  await Promise.all(threads);
  const elapsedMs = performance.now() - start;
  if (failures || successes !== workerCount) throw new Error("Real review worker failure: " + failures);
  const indexed = await db.sourceReviewSignal.count({ where: { repositoryId: repository.id } });
  const completed = await db.sourceReview.findMany({ where: {repositoryId:repository.id,
    changesetId:{in:queue}}, select: { createdAt:true,indexedAt:true } });
  const freshness=completed.map(x=>x.indexedAt?x.indexedAt.getTime()-x.createdAt.getTime():NaN);
  if(freshness.some(x=>!Number.isFinite(x)))throw new Error("Missing index freshness record");
  const output = { count: workerCount, concurrency, successes, failures, elapsedMs,
    throughputChangesPerSecond: successes * 1000 / elapsedMs,
    reviewLatencyMs: quantile(latencies), indexFreshnessFromQueueMs:quantile(freshness), indexedSignals: indexed,
    fullNativeSnapshotRead: false, actualSourceControlWorker: true };
  return output;
}
async function main() {
  const start = performance.now();
  const owner = await db.user.create({ data: {
    handle: "index-" + uuidSuffix, email: "index-" + uuidSuffix + "@example.invalid",
  } });
  const repository = await db.repository.create({ data: {
    ownerId: owner.id, slug: "related-" + uuidSuffix, name: "Related review performance fixture",
  } });
  const beforeStorage = await storedSizes();
  const seedStart = performance.now();
  const batchSize = 500;
  for (let startIndex = 0; startIndex < total; startIndex += batchSize) {
    const data = Array.from({ length: Math.min(batchSize, total - startIndex) },
      (_, offset) => row(startIndex + offset));
    await db.sourceChangeset.createMany({ data: data.map(entry => ({
      id: entry.id, repositoryId: repository.id, authorId: "SYSTEM:benchmark",
      message: entry.description,
    })) });
    await db.sourceReview.createMany({ data: data.map(entry => ({
      changesetId: entry.id, repositoryId: repository.id, state: "COMPLETED",
      fingerprint: entry.assessment.fingerprint, equivalenceHash: entry.equivalenceHash,
      paths: entry.assessment.paths, regions: entry.assessment.regions as unknown as import("@prisma/client").Prisma.InputJsonValue,
      riskTier: "LOW", riskScore: 0, embedding: (entry.embedding ?? undefined) as
        import("@prisma/client").Prisma.InputJsonValue | undefined,
      indexedAt: new Date(),
    })) });
    await db.sourceReviewSignal.createMany({ data: data.flatMap(entry =>
      entry.signals.map(signal => ({
        repositoryId: repository.id, changesetId: entry.id, kind: signal.kind, key: signal.key,
      }))) });
    await db.sourceReviewRegion.createMany({ data: data.flatMap(entry => entry.assessment.regions.map(region => ({
      repositoryId: repository.id, changesetId: entry.id, path: region.path,
      startLine: BigInt(region.start), endLine: BigInt(region.end), baseObject: region.baseObject,
    }))) });
  }
  const seedMs = performance.now() - seedStart;
  const afterStorage = await storedSizes();
  const stored = Object.fromEntries(Object.keys(afterStorage).map(key => [key, {
    tableBytes: afterStorage[key].tableBytes - beforeStorage[key].tableBytes,
    indexBytes: afterStorage[key].indexBytes - beforeStorage[key].indexBytes,
    totalBytes: afterStorage[key].totalBytes - beforeStorage[key].totalBytes,
  }]));
  const roles = [
    { name: "exact-history", query: total - 1, expected: 0, kind: "DUPLICATE" },
    { name: "equivalent-history", query: total - 2, expected: 1, kind: "EQUIVALENT" },
    { name: "line-conflict", query: total - 3, expected: 2, kind: "REGION" },
    { name: "independent-edit", query: total - 4, expected: 4, kind: "FILE" },
    { name: "semantic-equivalence", query: total - 5, expected: 3, kind: "SIMILAR" },
  ];
  const queries = [];
  const latencies: number[] = [];
  for (const item of roles) {
    const fixture = row(item.query);
    const measurements: number[] = [];
    let relation: { changesetId: string; kind: string } | undefined;
    let truncated = false, count = 0;
    for (let k = 0; k < 12; k++) {
      const time = performance.now();
      const answer = await discoverRelated({
        repositoryId: repository.id, changesetId: fixture.id, assessment: fixture.assessment,
        equivalenceHash: fixture.equivalenceHash, signals: fixture.signals,
        embedding: fixture.embedding ?? [], vectorNamespace: "fixture:64",
      });
      measurements.push(performance.now() - time);
      const expected = row(item.expected);
      relation = answer.relations.find(r => r.changesetId === expected.id);
      truncated = answer.truncated;
      count = answer.candidateCount;
    }
    latencies.push(...measurements);
    queries.push({ fixture: item.name, label: item.kind, detected: relation?.kind ?? null,
      passed: relation?.kind === item.kind, truncated, candidateSignals: count,
      queryMs: quantile(measurements) });
  }
  if (queries.some(x => !x.passed)) throw new Error("Labeled fixture recall regression: " +
    JSON.stringify(queries.filter(x => !x.passed)));
  const worker = await measureWorkerThroughput();
  const results = {
    benchmark: "DevHub repository-wide review index (PostgreSQL 16, real Prisma queries)",
    count: total, indexRows: total, indexedSignalRows: await db.sourceReviewSignal.count({
      where: { repositoryId: repository.id },
    }),
    indexedLineIntervals: await db.sourceReviewRegion.count({ where: { repositoryId: repository.id } }),
    seedMs, seedChangesPerSecond: total * 1000 / seedMs,
    actualPostgresStorage: stored,
    queryLatencyMs: quantile(latencies),
    labeledFixtureRecallAt48: queries.filter(x => x.passed).length / queries.length,
    labeledPairs: queries,
    realWorker: worker,
    totalBenchmarkElapsedMs: performance.now() - start,
    limitations: ["Data-generation source review rows are synthetic (native changeset metadata with persisted SQL indexes).",
      "The separate real-worker benchmark publishes genuine content-addressed changesets and runs processReview.",
      "Semantic vectors are deterministic fixture vectors; no external embedding-model quality is implied.",
      "Measured on a GitHub Actions single-host PostgreSQL service, not a deployed regional production cluster."],
    environment: { ci: process.env.GITHUB_ACTIONS === "true",
      runId: process.env.GITHUB_RUN_ID ?? null, commit: process.env.GITHUB_SHA ?? null,
      node: process.version, database: "PostgreSQL 16" },
  };
  await mkdir(output.split("/").slice(0, -1).join("/") || ".", { recursive: true });
  await writeFile(output, JSON.stringify(results, null, 2) + "\n");
  console.log(JSON.stringify(results));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => db.$disconnect());

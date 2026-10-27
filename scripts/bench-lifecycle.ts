import { randomBytes, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { writeFile } from "node:fs/promises";
import { db } from "../src/lib/prisma";
import { tokenHash } from "../src/lib/auth";
import { stageCanonicalBlob, createCanonicalChangeset, getCanonicalSnapshot } from "../src/source-control/canonical";
import { mutateReference } from "../src/source-control/refs";
import { runAuthorizedQuery, treeQuery, ancestryQuery, compareQuery } from "../src/source-control/query";
import { getObject } from "../src/source-control/service";
import { enqueueIntegration } from "../src/integration/service";
import { submitValidation } from "../src/validation/service";
import { SourceControlError } from "../src/source-control/contracts";
import { measured } from "../src/observability/telemetry";
import { benchmarkWorkspaces } from "../src/observability/workspace-benchmark";

// Only real persisted objects, changesets and source-control APIs contribute to
// results. No synthetic PR-metadata requests are counted as native throughput.
const opts = new Map(process.argv.slice(2).filter(x => x.startsWith("--") && x.includes("="))
  .map(s => { const [key, ...rest] = s.slice(2).split("="); return [key, rest.join("=")]; }));
const number = (key: string, fallback: number, cap: number) => {
  const value = Number(opts.get(key) ?? fallback);
  if (!Number.isSafeInteger(value) || value < 0 || value > cap) throw new Error("Invalid --" + key);
  return value;
};
const submissions = number("submissions", 1000, 10000);
const changesetCount = number("changesets", 10000, 50000);
const concurrency = Math.max(1, number("concurrency", 1000, 2000));
const deep = number("depth", 900, 950);
const monorepoPaths = number("monorepo-paths", 6000, 9000);
const refWriters = number("ref-writers", 128, 1000);
const ciJobs = number("ci-jobs", 1000, 10000);
const integrationJobs = number("integration-jobs", 400, 10000);
const queryCount = number("queries", 100, 5000);
const sampleBlobs = Math.max(1, number("blobs", 64, 2000));
if (submissions > changesetCount || !changesetCount) throw new Error("1 <= submissions <= changesets required");
if (process.env.NODE_ENV === "production" && process.env.DEVHUB_ALLOW_PERF_WRITES !== "yes")
  throw new Error("Refusing production load without DEVHUB_ALLOW_PERF_WRITES=yes");
const id = randomBytes(7).toString("hex");
const durations: Record<string, number[]> = {};
const failures: Record<string, Record<string, number>> = {};
const succeeded: Record<string, number> = {};
const totals: Record<string, number> = {};
const beforeCpu = process.cpuUsage();
const before = performance.now();
let peakRss = process.memoryUsage().rss;
const resourceSampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 100);
resourceSampler.unref();
const noteFailure = (name: string, error: unknown) => {
  const code = error instanceof SourceControlError ? error.code : error instanceof Error ? error.name : "UNKNOWN";
  failures[name] ??= {};
  failures[name][code] = (failures[name][code] || 0) + 1;
};
const percentile = (items: number[], q: number) => {
  if (!items.length) return null;
  const sorted = [...items].sort((a, b) => a - b);
  return Number(sorted[Math.ceil(q * sorted.length) - 1].toFixed(2));
};
async function pool(count: number, workers: number, fn: (i: number) => Promise<void>, name: string) {
  let next = 0;
  const samples = durations[name] ||= [];
  const start = performance.now();
  await Promise.all(Array.from({ length: Math.min(workers, count) }, async () => {
    while (next < count) {
      const i = next++;
      const t = performance.now();
      try { await fn(i); succeeded[name] = (succeeded[name] || 0) + 1; }
      catch (error) { noteFailure(name, error); }
      finally { samples.push(performance.now() - t); }
    }
  }));
  totals[name] = performance.now() - start;
}
function phaseReport() {
  return Object.fromEntries(Object.entries(durations).map(([name, samples]) => [name, {
    attempted: samples.length, completed: succeeded[name] || 0, failureCodes: failures[name] || {},
    elapsedSeconds: Number(((totals[name] || 0) / 1000).toFixed(2)),
    attemptsPerSecond: totals[name] ? Number((samples.length * 1000 / totals[name]).toFixed(2)) : 0,
    successfulPerSecond: totals[name] ? Number(((succeeded[name] || 0) * 1000 / totals[name]).toFixed(2)) : 0,
    p50Ms: percentile(samples, .5), p95Ms: percentile(samples, .95), p99Ms: percentile(samples, .99),
  }]));
}
let createdRepo = "";
let output: object = {};
try {
  const user = await db.user.create({ data: { handle: "perf-" + id, email: "perf-" + id + "@example.invalid" } });
  const session = await db.humanSession.create({ data: { userId: user.id,
    tokenHash: tokenHash(randomBytes(32).toString("hex")), expiresAt: new Date(Date.now() + 48 * 3600_000) } });
  const actor = { type: "HUMAN" as const, id: user.id, sessionId: session.id };
  const repository = await db.repository.create({ data: { ownerId: user.id, slug: "perf-" + id, name: "Native performance " + id,
    requireHumanApproval: false, maxStoredBytes: BigInt(1_073_741_824) } });
  createdRepo = repository.id;

  let stagedBytes = 0;
  const objectIds: string[] = [];
  await pool(sampleBlobs, Math.min(concurrency, 24), async i => {
    const content = Buffer.from("native-object-" + id + "-" + i + "\n" + randomBytes(32).toString("hex"));
    const receipt = await measured("blob.stage", () => stageCanonicalBlob(repository.id, actor, content.toString("base64")));
    objectIds[i] = receipt.id; stagedBytes += content.byteLength;
  }, "real_blob_publication");
  if (objectIds.some(x => !x) || (succeeded.real_blob_publication || 0) !== sampleBlobs)
    throw new Error("Cannot continue without published real objects");

  const root = await measured("changeset.publish", () => createCanonicalChangeset(repository.id, actor, {
    apiVersion: 2, parents: [], description: "Benchmark root",
    operations: [{ kind: "ADD", path: "base.txt", objectId: objectIds[0] }],
  }));
  const changes: string[] = new Array(changesetCount);
  // Burst measures N simultaneous *native* submissions, each referencing a
  // verified blob and a genuine immutable root parent.
  await pool(submissions, concurrency, async i => {
    const published = await measured("changeset.publish", () => createCanonicalChangeset(repository.id, actor, {
      apiVersion: 2, parents: [root.id], description: "burst-" + i,
      idempotencyKey: "burst-" + id + "-" + i,
      operations: [{ kind: "ADD", path: "changes/burst-" + i + ".txt", objectId: objectIds[i % objectIds.length] }],
    }));
    changes[i] = published.id;
  }, "concurrent_change_submissions");
  // The 10k independent workload is not inflated by root or monorepo fixtures.
  await pool(changesetCount - submissions, Math.min(concurrency, 128), async i => {
    const index = i + submissions;
    const result = await measured("changeset.publish", () => createCanonicalChangeset(repository.id, actor, {
      apiVersion: 2, parents: [root.id], description: "independent-" + index,
      idempotencyKey: "ind-" + id + "-" + index,
      operations: [{ kind: "ADD", path: "changes/ind-" + index + ".txt",
        objectId: objectIds[index % objectIds.length] }],
    }));
    changes[index] = result.id;
  }, "independent_changeset_publication");
  if (changes.some(x => !x)) throw new Error("Incomplete publication: inspect failure codes");
  const persisted = await db.sourceChangeset.count({ where: { repositoryId: repository.id } });
  if (persisted !== changesetCount + 1)
    throw new Error("Durability mismatch: persisted changesets " + persisted);

  let tip = root.id;
  const deepStart = performance.now();
  durations.deep_ancestry_publication = [];
  for (let i = 0; i < deep; i++) {
    const itemStart = performance.now();
    const result = await measured("changeset.publish", () => createCanonicalChangeset(repository.id, actor, {
      apiVersion: 2, parents: [tip], description: "deep-" + i,
      operations: [{ kind: "ADD", path: "history/" + i + ".txt", objectId: objectIds[i % objectIds.length] }],
    }));
    durations.deep_ancestry_publication.push(performance.now() - itemStart);
    tip = result.id;
  }
  totals.deep_ancestry_publication = performance.now() - deepStart;
  succeeded.deep_ancestry_publication = deep;
  await runAuthorizedQuery(actor, repository.id, async () => {
    const ancestorResult = await ancestryQuery(repository.id, tip, undefined, 20);
    if (ancestorResult.ancestorCount !== deep) throw new Error("Deep ancestry lost parents");
  });

  let monorepoTip = root.id;
  const monoStart = performance.now();
  durations.monorepo_publication = [];
  for (let offset = 0; offset < monorepoPaths; offset += 100) {
    const itemStart = performance.now();
    const operations = Array.from({ length: Math.min(100, monorepoPaths - offset) }, (_, index) => {
      const n = offset + index;
      return { kind: "ADD" as const, path: "packages/pkg" + String(n % 80).padStart(3, "0") +
        "/file-" + n + ".txt", objectId: objectIds[n % objectIds.length] };
    });
    const result = await measured("changeset.publish", () => createCanonicalChangeset(repository.id, actor, {
      apiVersion: 2, parents: [monorepoTip], description: "monorepo-paths-" + offset, operations,
    }));
    monorepoTip = result.id;
    durations.monorepo_publication.push(performance.now() - itemStart);
  }
  totals.monorepo_publication = performance.now() - monoStart;
  succeeded.monorepo_publication = Math.ceil(monorepoPaths / 100);
  const snapshot = await getCanonicalSnapshot(repository.id, monorepoTip, actor);
  if (snapshot.entries.length !== monorepoPaths + 1) throw new Error("Monorepo snapshot lost paths");
  const workspaces = await benchmarkWorkspaces(repository.id, actor, snapshot.entries);
  const firstBlob = await getObject(repository.id, objectIds[0], actor);
  if (firstBlob.id !== objectIds[0]) throw new Error("Object round-trip failed");

  await pool(queryCount, Math.min(concurrency, 32), async i => {
    await measured("query.read", () => runAuthorizedQuery(actor, repository.id, async () => {
      if (i % 3 === 0) return treeQuery(repository.id, monorepoTip, "packages/pkg000", 30);
      if (i % 3 === 1) return ancestryQuery(repository.id, tip, undefined, 30);
      return compareQuery(repository.id, root.id, changes[i % changes.length]);
    }));
  }, "source_control_queries");

  const staging = await mutateReference(repository.id, actor, { name: "branches/perf", operation: "CREATE",
    mutationId: "initialize-" + id, expectedGeneration: null, changesetId: root.id });
  const firstGeneration = staging.ref.generation;
  let winners = 0, stale = 0;
  await pool(refWriters, Math.min(refWriters, concurrency), async i => {
    try {
      await measured("ref.mutate", () => mutateReference(repository.id, actor, {
        name: "branches/perf", operation: "UPDATE", changesetId: changes[i % changes.length],
        expectedGeneration: firstGeneration, mutationId: "race-" + id + "-" + i,
      }));
      winners++;
    } catch (error) {
      if (error instanceof SourceControlError && error.code === "REFERENCE_CONFLICT") { stale++; return; }
      throw error;
    }
  }, "concurrent_ref_cas");
  const after = await db.sourceReference.findUniqueOrThrow({ where: {
    repositoryId_name: { repositoryId: repository.id, name: "branches/perf" },
  } });
  if (refWriters > 0 && (winners !== 1 || stale !== refWriters - 1 || after.generation !== firstGeneration + 1))
    throw new Error("Ref CAS integrity violated: expected exactly one winner");

  await pool(integrationJobs, Math.min(concurrency, 64), async i => {
    await measured("integration.enqueue", () => enqueueIntegration(repository.id, actor, {
      sourceChangesetId: changes[i % changes.length], targetRef: "branches/perf",
      requestKey: "perf-integration-" + id + "-" + i,
    }));
  }, "integration_admission");

  // Actual durable CI admissions. Execution duration needs running disposable
  // runner workers, and unsigned/fabricated results are never synthesized.
  const configured = ["VALIDATION_NODE_IMAGE", "VALIDATION_SCAN_IMAGE", "VALIDATION_SECRETS_IMAGE"]
    .every(name => !!process.env[name]);
  if (configured) await pool(ciJobs, Math.min(concurrency, 32), async i => {
    await measured("validation.submit", () => submitValidation(repository.id, changes[i % changes.length],
      null, "perfvalidation" + id + i, actor));
  }, "validation_storm_admission");
  const pipelineCount = await db.validationPipeline.count({ where: { repositoryId: repository.id } });
  const integrationStates = await db.changeIntegration.groupBy({ by: ["state"],
    where: { repositoryId: repository.id }, _count: { _all: true } });
  const cpu = process.cpuUsage(beforeCpu);
  output = {
    runId: id, completedAt: new Date().toISOString(), repositoryId: repository.id, topology: {
      driver: "Node.js native service APIs", database: "PostgreSQL", objectStorage: "SourceObject inline verified blobs",
      cache: "source-control query LRU; optional separate node and regional caches",
      driverConcurrency: concurrency,
    }, input: { submissions, changesetCount, concurrency, deep, monorepoPaths, refWriters,
      integrationJobs, ciJobs, queryCount, sampleBlobs }, phases: phaseReport(),
    workspaces,
    integrity: { expectedIndependentChangesets: changesetCount, persistedAfterIndependentPhase: persisted,
      monorepoPaths: snapshot.entries.length - 1, deepFirstParentDepth: deep,
      refCasWinners: winners, refCasStaleRejected: stale, refGeneration: after.generation,
      validationPipelines: pipelineCount, integrationStates },
    resources: { elapsedSeconds: Number(((performance.now() - before) / 1000).toFixed(2)),
      cpuSeconds: (cpu.user + cpu.system) / 1e6, driverPeakRssBytes: peakRss,
      driverFinalRssBytes: process.memoryUsage().rss,
      stagedBlobPayloadBytes: stagedBytes },
    unavailable: ["Measured S3 object-store traffic: this profile uses inline canonical blobs; run storage benchmark separately",
      "Actual CI execution durations require isolated runners",
      "Multi-region cache hit rates require per-cache /v1/status; workspace fixture reports local node-cache hit/miss counts",
      "Worker process CPU and memory require per-process telemetry"],
    validationStorm: configured ? "admission attempted against configured immutable runner images"
      : "SKIPPED: immutable validation OCI image configuration not supplied",
    caveat: "Results characterize only this deployment and runtime; HTTP ingress and Git gateway are separate workloads.",
  };
} catch (error) {
  output = { runId: id, failedAt: new Date().toISOString(), repositoryId: createdRepo,
    error: error instanceof Error ? { name: error.name, message: error.message } : { name: "unknown" },
    partialPhases: phaseReport() };
  process.exitCode = 1;
} finally {
  clearInterval(resourceSampler);
  const json = JSON.stringify(output, null, 2);
  console.log(json);
  if (opts.has("output")) await writeFile(opts.get("output")!, json + "\n", { mode: 0o600 });
  await db.$disconnect();
}

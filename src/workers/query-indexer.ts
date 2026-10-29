import { measured } from "../observability/telemetry";
import { randomUUID } from "node:crypto";
import { processDerivedBatch } from "../source-control/derived-index";
import { db } from "../lib/prisma";
import { fairCandidates, fairClaim } from "./tenant-scheduler";
import { indexSearchBatch, enqueueSearchObjects } from "./search-indexer";

// A lease is stored in PostgreSQL, so a worker crash or deployment restart
// cannot permanently strand derived indexing. Retrying is idempotent.
export async function ensureIndexJob(repositoryId: string, changesetId: string) {
  await db.sourceQueryIndexJob.createMany({ data: [{ repositoryId, changesetId }], skipDuplicates: true });
}

export async function indexChangeset(changesetId: string, preclaimedToken?: string): Promise<boolean> {
  const now = new Date();
  const leaseToken = preclaimedToken ?? randomUUID();
  if (!preclaimedToken) {
    const claimed = await db.sourceQueryIndexJob.updateMany({
      where: { changesetId, nextAttemptAt: { lte: now }, OR: [
        { state: "QUEUED" }, { state: "RUNNING", leaseUntil: { lt: now } },
      ] },
      data: { state: "RUNNING", attempts: { increment: 1 },
        leaseUntil: new Date(now.getTime() + 90_000), leaseToken, lastError: null },
    });
    if (!claimed.count) return false;
  }
  try {
    const source = await db.sourceChangeset.findUniqueOrThrow({ where: { id: changesetId },
      include: { parents: { orderBy: { position: "asc" } }, operations: true } });
    const parentIds = source.parents.map(p => p.parentId);
    const indexedParents = await db.sourceQueryIndexJob.findMany({ where: {
      changesetId: { in: parentIds }, state: "SUCCEEDED",
    }, select: { changesetId: true, generation: true } });
    if (indexedParents.length !== parentIds.length || indexedParents.some(p => p.generation === null)) {
      if (parentIds.length) {
        const missing = parentIds.filter(id => !indexedParents.some(p => p.changesetId === id));
        await db.sourceQueryIndexJob.createMany({
          data: missing.map(id => ({ changesetId: id, repositoryId: source.repositoryId })), skipDuplicates: true,
        });
      }
      await db.sourceQueryIndexJob.updateMany({ where: { changesetId, state: "RUNNING",
        leaseToken, leaseUntil: { gt: new Date() } }, data: {
        state: "QUEUED", leaseUntil: null, leaseToken: null, nextAttemptAt: new Date(Date.now() + 1_000),
      } });
      return false;
    }
    const generation = Math.max(0, ...indexedParents.map(p => p.generation!)) + 1;
    const touches = source.operations.flatMap(op => [
      { changesetId, path: op.path, operationPath: op.path, role: "destination" },
      ...(op.previousPath
        ? [{ changesetId, path: op.previousPath, operationPath: op.path, role: "source" }]
        : []),
    ]);
    await enqueueSearchObjects(source.operations.map(op => op.objectId).filter((id): id is string => !!id));
    const published = await db.$transaction(async tx => {
      const finished = await tx.sourceQueryIndexJob.updateMany({
        where: { changesetId, state: "RUNNING", leaseToken, leaseUntil: { gt: new Date() } },
        data: { state: "SUCCEEDED", generation, indexedAt: new Date(),
          leaseUntil: null, leaseToken: null, lastError: null },
      });
      if (!finished.count) return false;
      if (touches.length) await tx.sourceQueryPathTouch.createMany({ data: touches, skipDuplicates: true });
      return true;
    });
    return published;
  } catch (error) {
    const failure = error instanceof Error ? error.message.slice(0, 1000) : "Unknown indexing failure";
    const current = await db.sourceQueryIndexJob.findUniqueOrThrow({ where: { changesetId } });
    await db.sourceQueryIndexJob.updateMany({ where: { changesetId,
      state: "RUNNING", leaseToken, leaseUntil: { gt: new Date() } }, data: {
      state: current.attempts >= 10 ? "FAILED" : "QUEUED",
      lastError: failure, leaseUntil: null, leaseToken: null,
      nextAttemptAt: new Date(Date.now() + Math.min(30_000, 500 * 2 ** Math.min(current.attempts, 6))),
    } });
    throw error;
  }
}

export async function indexBatch(batchSize = 32) {
  const candidates = (await fairCandidates("source-index")).slice(0,Math.min(100,Math.max(1,batchSize)));
  let completed = 0;
  for (const candidate of candidates) {
    const token = await fairClaim("source-index", candidate.tenantId, async tx => {
      const now = new Date();
      const leaseToken = randomUUID();
      const claimed = await tx.sourceQueryIndexJob.updateMany({
        where: { changesetId: candidate.id, nextAttemptAt: { lte: now }, OR: [
          { state: "QUEUED" }, { state: "RUNNING", leaseUntil: { lt: now } },
        ] },
        data: { state: "RUNNING", attempts: { increment: 1 },
          leaseUntil: new Date(now.getTime() + 90_000), leaseToken, lastError: null },
      });
      return claimed.count ? leaseToken : null;
    });
    if (!token) continue;
    try { if (await measured("worker.index", () => indexChangeset(candidate.id, token))) completed++; }
    catch (error) { console.error("Query indexing failed", candidate.id, error); }
  }
  return { inspected: candidates.length, completed };
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function main() {
  let stopping = false;
  process.on("SIGTERM", () => { stopping = true; });
  process.on("SIGINT", () => { stopping = true; });
  try {
    while (!stopping) {
      const batch = await indexBatch();
      const search = await indexSearchBatch();
      const derived = await processDerivedBatch();
      if (!batch.inspected && !search.inspected && !derived.inspected) await sleep(1000);
      else if (!batch.completed && !search.completed && !derived.completed) await sleep(250);
    }
  } finally { await db.$disconnect(); }
}
if (process.argv[1]?.endsWith("query-indexer.ts")) main().catch(error => { console.error(error); process.exitCode = 1; });

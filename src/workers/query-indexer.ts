import { db } from "../lib/prisma";

// A lease is stored in PostgreSQL, so a worker crash or deployment restart
// cannot permanently strand derived indexing. Retrying is idempotent.
export async function ensureIndexJob(repositoryId: string, changesetId: string) {
  await db.sourceQueryIndexJob.createMany({ data: [{ repositoryId, changesetId }], skipDuplicates: true });
}

export async function indexChangeset(changesetId: string): Promise<boolean> {
  const now = new Date();
  const claimed = await db.sourceQueryIndexJob.updateMany({
    where: { changesetId, nextAttemptAt: { lte: now }, OR: [
      { state: "QUEUED" }, { state: "RUNNING", leaseUntil: { lt: now } },
    ] },
    data: { state: "RUNNING", attempts: { increment: 1 },
      leaseUntil: new Date(now.getTime() + 90_000), lastError: null },
  });
  if (!claimed.count) return false;
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
      await db.sourceQueryIndexJob.update({ where: { changesetId }, data: {
        state: "QUEUED", leaseUntil: null, nextAttemptAt: new Date(Date.now() + 1_000),
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
    await db.$transaction(async tx => {
      if (touches.length) await tx.sourceQueryPathTouch.createMany({ data: touches, skipDuplicates: true });
      await tx.sourceQueryIndexJob.update({ where: { changesetId }, data: {
        state: "SUCCEEDED", generation, indexedAt: new Date(), leaseUntil: null, lastError: null,
      } });
    });
    return true;
  } catch (error) {
    const failure = error instanceof Error ? error.message.slice(0, 1000) : "Unknown indexing failure";
    const current = await db.sourceQueryIndexJob.findUniqueOrThrow({ where: { changesetId } });
    await db.sourceQueryIndexJob.update({ where: { changesetId }, data: {
      state: current.attempts >= 10 ? "FAILED" : "QUEUED",
      lastError: failure, leaseUntil: null,
      nextAttemptAt: new Date(Date.now() + Math.min(30_000, 500 * 2 ** Math.min(current.attempts, 6))),
    } });
    throw error;
  }
}

export async function indexBatch(batchSize = 32) {
  const now = new Date();
  const jobs = await db.sourceQueryIndexJob.findMany({ where: { nextAttemptAt: { lte: now }, OR: [
    { state: "QUEUED" }, { state: "RUNNING", leaseUntil: { lt: now } },
  ] }, orderBy: { createdAt: "asc" }, take: Math.min(100, Math.max(1, batchSize)), select: { changesetId: true } });
  let completed = 0;
  for (const job of jobs) {
    try { if (await indexChangeset(job.changesetId)) completed++; }
    catch (error) { console.error("Query indexing failed", job.changesetId, error); }
  }
  return { inspected: jobs.length, completed };
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function main() {
  let stopping = false;
  process.on("SIGTERM", () => { stopping = true; });
  process.on("SIGINT", () => { stopping = true; });
  try {
    while (!stopping) {
      const batch = await indexBatch();
      if (!batch.inspected) await sleep(1000);
      else if (!batch.completed) await sleep(250);
    }
  } finally { await db.$disconnect(); }
}
if (process.argv[1]?.endsWith("query-indexer.ts")) main().catch(error => { console.error(error); process.exitCode = 1; });

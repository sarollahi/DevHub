import { Worker, type Job } from "bullmq";
import { Prisma } from "@prisma/client";
import { db } from "../lib/prisma";
import { QUEUE_NAME, redisConnection, type ProcessMessage } from "../lib/queue";
import { assessChange } from "../lib/review-logic";

export async function processPreflight(message: ProcessMessage) {
  const item = await db.queueJob.findUnique({ where: { id: message.jobId }, include: { pull: true } });
  if (!item) throw new Error("Unknown durable job");
  if (item.state === "SUCCEEDED" || item.state === "CANCELLED") return;
  if (item.pullId !== message.pullId || item.pull.version !== message.version) throw new Error("Stale or inconsistent processing request");
  const lease = new Date(Date.now() + 120_000);
  const claimed = await db.queueJob.updateMany({ where: { id: item.id, OR: [
    { state: { in: ["QUEUED", "FAILED"] } },
    { state: "RUNNING", leaseUntil: { lt: new Date() } },
  ] }, data: { state: "RUNNING", startedAt: new Date(), leaseUntil: lease, attempts: { increment: 1 }, lastError: null } });
  if (claimed.count === 0) throw new Error("Processing lease currently held; will retry");
  try {
    const assessment = assessChange(item.pull.changedFiles, item.pull.patch);
    await db.$transaction(async (tx) => {
      const pr = await tx.pullRequest.findUniqueOrThrow({ where: { id: item.pullId } });
      if (pr.version !== message.version || pr.state === "CLOSED" || pr.state === "MERGED") {
        await tx.queueJob.update({ where: { id: item.id }, data: { state: "CANCELLED", leaseUntil: null, finishedAt: new Date() } });
        return;
      }
      const duplicateCount = await tx.changeFingerprint.count({ where: {
        repositoryId: pr.repositoryId, sha256: assessment.fingerprint, NOT: { pullId: pr.id },
      } });
      await tx.changeFingerprint.upsert({ where: { pullId: pr.id },
        create: { repositoryId: pr.repositoryId, pullId: pr.id, sha256: assessment.fingerprint,
          fileSetHash: assessment.fileSetHash, relatedCount: duplicateCount },
        update: { sha256: assessment.fingerprint, fileSetHash: assessment.fileSetHash, relatedCount: duplicateCount },
      });
      const summary = ["Metadata and patch parsed successfully", ...assessment.flags,
        ...(duplicateCount ? [`${duplicateCount} identical patch fingerprint(s) require review`] : [])].join("; ");
      await tx.checkRun.create({ data: { pullId: pr.id, name: "metadata-validation", state: "SUCCESS",
        summary, startedAt: new Date(), endedAt: new Date() } });
      await tx.pullRequest.update({ where: { id: pr.id }, data: {
        state: "REVIEW_REQUIRED", riskTier: assessment.riskTier, riskScore: assessment.riskScore,
      } });
      await tx.queueJob.update({ where: { id: item.id }, data: { state: "SUCCEEDED", leaseUntil: null, finishedAt: new Date() } });
      await tx.auditEvent.create({ data: { repositoryId: pr.repositoryId, actorType: "SYSTEM", actorId: "preflight-worker",
        action: "pull_request.preflight_completed", subjectId: pr.id,
        metadata: { riskScore: assessment.riskScore, riskTier: assessment.riskTier, exactDuplicates: duplicateCount } } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 15000 });
  } catch (error) {
    await db.queueJob.update({ where: { id: item.id }, data: { state: "QUEUED", leaseUntil: null,
      lastError: error instanceof Error ? error.message.slice(0, 1000) : "unknown error" } });
    throw error;
  }
}

async function main() {
  const connection = redisConnection();
  const concurrency = Math.min(64, Math.max(1, Number(process.env.WORKER_CONCURRENCY ?? 4)));
  const worker = new Worker<ProcessMessage>(QUEUE_NAME, async (job: Job<ProcessMessage>) => {
    try { await processPreflight(job.data); }
    catch (error) {
      if (job.attemptsMade + 1 >= (job.opts.attempts || 1)) {
        await db.$transaction(async (tx) => {
          await tx.queueJob.update({ where: { id: job.data.jobId }, data: { state: "FAILED", leaseUntil: null,
            finishedAt: new Date(), lastError: error instanceof Error ? error.message.slice(0, 1000) : "failed" } });
          await tx.pullRequest.updateMany({ where: { id: job.data.pullId, state: { notIn: ["MERGED", "CLOSED"] } }, data: { state: "FAILED" } });
          await tx.checkRun.create({ data: { pullId: job.data.pullId, name: "metadata-validation", state: "FAILURE",
            summary: "Preflight failed after configured retries", endedAt: new Date() } });
        });
      }
      throw error;
    }
  }, { connection, concurrency });
  worker.on("failed", (job, error) => console.error("Preflight failed:", job?.id, error.message));
  const shutdown = async () => { await worker.close(); await connection.quit(); await db.$disconnect(); };
  process.once("SIGTERM", () => { void shutdown(); });
  process.once("SIGINT", () => { void shutdown(); });
  console.log(`DevHub preflight worker started (concurrency ${concurrency})`);
}
if (process.argv[1]?.endsWith("processor.ts")) main().catch((error) => { console.error(error); process.exitCode = 1; });

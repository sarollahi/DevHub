import { Prisma, type ValidationPipeline, type ValidationTask } from "@prisma/client";
import { db } from "../lib/prisma";
import { SourceControlError } from "../source-control/contracts";
import { snapshotFor } from "./snapshot";
import { configurationDigest, fingerprint, KINDS, recipes, verifyTask } from "./policy";

const uuidOrKey = /^[a-zA-Z0-9_-]{8,128}$/;
export async function submitValidation(repositoryId: string, changesetId: string, targetId: string | null,
  idempotencyKey: string, actor: string) {
  if (!uuidOrKey.test(idempotencyKey)) throw new SourceControlError(422, "INVALID_KEY", "Idempotency key must contain 8-128 safe characters");
  const available = await db.sourceChangeset.findMany({
    where: { repositoryId, id: { in: targetId ? [changesetId, targetId] : [changesetId] } }, select: { id: true },
  });
  if (available.length !== (targetId && targetId !== changesetId ? 2 : 1) || targetId === changesetId) {
    throw new SourceControlError(404, "NOT_FOUND", "Changeset or target does not belong to this repository");
  }
  const policy = recipes();
  const snapshot = await snapshotFor(repositoryId, changesetId, targetId);
  const configHash = configurationDigest(policy);
  return db.$transaction(async tx => {
    const repo = await tx.repository.findUniqueOrThrow({ where: { id: repositoryId } });
    // Lock tenant admission, not the repository contents or commit DAG.
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${repo.ownerId}::uuid FOR UPDATE`;
    const previous = await tx.validationPipeline.findUnique({ where: {
      repositoryId_idempotencyKey: { repositoryId, idempotencyKey },
    } });
    if (previous) {
      if (previous.changesetId !== changesetId || previous.targetChangesetId !== targetId ||
          previous.snapshotDigest !== snapshot.digest || previous.configurationDigest !== configHash) {
        throw new SourceControlError(409, "IDEMPOTENCY_CONFLICT", "The validation key belongs to different inputs");
      }
      return { pipeline: previous, created: false };
    }
    const max = Math.min(200, Math.max(1, Number(process.env.VALIDATION_TENANT_MAX_PENDING || 48)));
    const count = await tx.validationTask.count({ where: { state: { in: ["QUEUED", "RUNNING"] },
      pipeline: { repository: { ownerId: repo.ownerId } } } });
    if (count + policy.length > max) throw new SourceControlError(429, "TENANT_QUEUE_QUOTA", "Tenant has too many pending checks");
    const pipeline = await tx.validationPipeline.create({ data: {
      repositoryId, changesetId, targetChangesetId: targetId, idempotencyKey, requestedBy: actor,
      snapshotDigest: snapshot.digest, dependencyDigest: snapshot.dependencyDigest, configurationDigest: configHash,
      tasks: { create: policy.map(recipe => ({
        kind: recipe.kind, image: recipe.image, command: recipe.command, timeoutSeconds: recipe.timeoutSeconds,
        fingerprint: fingerprint(repositoryId, changesetId, targetId, snapshot.digest, snapshot.dependencyDigest, recipe),
      })) },
    } });
    await tx.auditEvent.create({ data: { repositoryId, actorType: "SYSTEM", actorId: actor,
      action: "validation.submitted", subjectId: pipeline.id,
      metadata: { changesetId, targetId, snapshotDigest: snapshot.digest, configurationDigest: configHash } } });
    return { pipeline, created: true };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}
export async function pipelineDetail(repositoryId: string, pipelineId: string) {
  return db.validationPipeline.findFirst({ where: { repositoryId, id: pipelineId },
    include: { tasks: { orderBy: { kind: "asc" }, select: {
      id: true, kind: true, state: true, fingerprint: true, image: true, command: true,
      attempt: true, maxAttempts: true, startedAt: true, finishedAt: true, exitCode: true,
      summary: true, logDigest: true, artifactDigest: true, reusedFromId: true,
      artifacts: { select: { id:true, name:true, mediaType:true, digest:true } },
    } } } });
}
export async function cancelPipeline(repositoryId: string, pipelineId: string) {
  const updated = await db.$transaction(async tx => {
    const pipeline = await tx.validationPipeline.findFirst({ where: { id: pipelineId, repositoryId } });
    if (!pipeline) throw new SourceControlError(404, "NOT_FOUND", "Validation not found");
    await tx.validationTask.updateMany({ where: { pipelineId, state: { in: ["QUEUED", "RUNNING"] } }, data: {
      state: "CANCELLED", leaseToken: null, leaseUntil: null, finishedAt: new Date(), summary: "Cancelled by authorized user",
    } });
    await tx.validationPipeline.update({ where: { id: pipelineId }, data: { state: "CANCELLED", finishedAt: new Date() } });
    await tx.auditEvent.create({ data: { repositoryId, actorType: "HUMAN", actorId: "validation-api",
      action: "validation.cancelled", subjectId: pipelineId } });
    return pipeline;
  });
  return updated;
}
export async function refreshPipeline(pipelineId: string) {
  const tasks = await db.validationTask.findMany({ where: { pipelineId }, select: { state: true } });
  const status = tasks.some(t => t.state === "RUNNING") ? "RUNNING" :
    tasks.some(t => t.state === "QUEUED") ? "QUEUED" :
    tasks.some(t => t.state === "ERRORED" || t.state === "TIMED_OUT") ? "ERRORED" :
    tasks.some(t => t.state === "CANCELLED") ? "CANCELLED" :
    tasks.some(t => t.state === "FAILED") ? "FAILED" : "PASSED";
  await db.validationPipeline.updateMany({ where: { id: pipelineId, state: { not: "CANCELLED" } },
    data: { state: status, finishedAt: ["PASSED", "FAILED", "ERRORED", "CANCELLED"].includes(status) ? new Date() : null } });
}
export async function hasVerifiedChecks(repositoryId: string, changesetId: string, targetId: string | null): Promise<boolean> {
  let current;
  try { current = recipes(); } catch { return false; }
  const configHash = configurationDigest(current);
  const latest = await db.validationPipeline.findFirst({ where: {
    repositoryId, changesetId, targetChangesetId: targetId, configurationDigest: configHash, state: "PASSED",
  }, orderBy: { createdAt: "desc" }, include: { tasks: true } });
  if (!latest || latest.tasks.length !== KINDS.length) return false;
  let snapshot;
  try { snapshot = await snapshotFor(repositoryId, changesetId, targetId); } catch { return false; }
  if (latest.snapshotDigest !== snapshot.digest || latest.dependencyDigest !== snapshot.dependencyDigest) return false;
  return current.every(recipe => {
    const task = latest.tasks.find(t => t.kind === recipe.kind);
    return !!task && task.state === "PASSED" && !!task.signature && verifyTask(task) &&
      task.fingerprint === fingerprint(repositoryId, changesetId, targetId,
        snapshot.digest, snapshot.dependencyDigest, recipe);
  });
}

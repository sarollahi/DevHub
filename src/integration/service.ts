import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "../lib/prisma";
import { assertRepositoryPermission } from "../lib/authorization";
import { SourceControlError, type SourceActor } from "../source-control/contracts";
import { createCanonicalChangeset, readCanonicalSnapshotForValidation } from "../source-control/canonical";
import { validateRefName, isAncestor } from "../source-control/refs";
import { mergeBases, runAuthorizedQuery } from "../source-control/query";
import { hasVerifiedChecks, submitValidation } from "../validation/service";
import { configurationDigest, fingerprint, KINDS, recipes, verifyTask } from "../validation/policy";
import { snapshotFor } from "../validation/snapshot";
import { planIntegration } from "./plan";

const ID = /^[0-9a-f]{64}$/;
const KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const digest = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex");
const seconds = (s: number) => new Date(Date.now() + s * 1000);
const defaultPolicy = { preChecks: true, targetChecks: true, postChecks: true, deploymentChecks: true, maxRetries: 8 };
const transient = new Set(["REFERENCE_CONFLICT", "TARGET_MOVED", "CHECKS_NOT_READY", "APPROVAL_MISSING"]);
type Integration = NonNullable<Awaited<ReturnType<typeof db.changeIntegration.findUnique>>>;
type Policy = typeof defaultPolicy;
type Stage = { name: "pre" | "target" | "post" | "deployment"; subject: string; target: string | null };
const stageKey = (id: string, stage: Stage) => "integration-" + digest([id, stage.name, stage.subject, stage.target]).slice(0, 48);
const actorFrom = (job: Integration): SourceActor => ({
  type: job.actorType as SourceActor["type"], id: job.actorId,
  sessionId: job.actorSessionId ?? undefined, credentialId: job.actorCredentialId ?? undefined,
});
async function policyFor(repositoryId: string, targetRef: string, isProtected: boolean): Promise<Policy> {
  const policy = await db.integrationPolicy.findUnique({ where: { repositoryId_targetRef: { repositoryId, targetRef } } });
  if (!policy) return defaultPolicy;
  return {
    preChecks: isProtected || policy.preChecks,
    targetChecks: isProtected || policy.targetChecks,
    postChecks: isProtected || policy.postChecks,
    deploymentChecks: isProtected || policy.deploymentChecks,
    maxRetries: Math.max(1, Math.min(32, policy.maxRetries)),
  };
}
export async function enqueueIntegration(repositoryId: string, actor: SourceActor, body: {
  sourceChangesetId: string; targetRef: string; requestKey: string;
  mode?: "MERGE" | "REVERT"; revertIntegrationId?: string; resolutionOfId?: string;
}) {
  if (!ID.test(body.sourceChangesetId) || !KEY.test(body.requestKey) ||
      !["MERGE", "REVERT"].includes(body.mode ?? "MERGE")) {
    throw new SourceControlError(422, "INVALID_INPUT", "A changeset, request key and valid mode are required");
  }
  validateRefName(body.targetRef);
  await assertRepositoryPermission(actor, repositoryId, "ref:update", { branch: body.targetRef });
  await assertRepositoryPermission(actor, repositoryId, "changeset:write", { allowStaging: true });
  return db.$transaction(async tx => {
    await assertRepositoryPermission(actor, repositoryId, "ref:update", { branch: body.targetRef }, tx);
    await assertRepositoryPermission(actor, repositoryId, "changeset:write", { allowStaging: true }, tx);
    const existing = await tx.changeIntegration.findUnique({ where: {
      repositoryId_requestKey: { repositoryId, requestKey: body.requestKey },
    } });
    if (existing) {
      if (existing.sourceChangesetId !== body.sourceChangesetId || existing.targetRef !== body.targetRef ||
          existing.mode !== (body.mode ?? "MERGE") || existing.revertIntegrationId !== (body.revertIntegrationId ?? null) ||
          existing.resolutionOfId !== (body.resolutionOfId ?? null)) {
        throw new SourceControlError(409, "IDEMPOTENCY_CONFLICT", "Integration key already belongs to another request");
      }
      return existing;
    }
    const [ref, source, repository] = await Promise.all([
      tx.sourceReference.findUnique({ where: { repositoryId_name: { repositoryId, name: body.targetRef } } }),
      tx.sourceChangeset.findFirst({ where: { repositoryId, id: body.sourceChangesetId } }),
      tx.repository.findUnique({ where: { id: repositoryId } }),
    ]);
    if (!ref || ref.deletedAt || ref.kind !== "BRANCH" || !source || !repository) {
      throw new SourceControlError(404, "INTEGRATION_INPUT_NOT_FOUND", "Active target branch and published changeset required");
    }
    if (body.mode === "REVERT") {
      const prior = body.revertIntegrationId ? await tx.changeIntegration.findFirst({ where: {
        id: body.revertIntegrationId, repositoryId, state: "INTEGRATED", targetRef: body.targetRef,
      } }) : null;
      if (!prior || prior.resultChangesetId !== body.sourceChangesetId || !prior.targetChangesetId) {
        throw new SourceControlError(422, "INVALID_REVERT", "Revert must reference an integrated changeset and its target");
      }
    } else if (body.revertIntegrationId) {
      throw new SourceControlError(422, "INVALID_INPUT", "Only revert jobs accept revertIntegrationId");
    }
    if (body.resolutionOfId) {
      const original = await tx.changeIntegration.findFirst({ where: {
        id: body.resolutionOfId, repositoryId, targetRef: body.targetRef, state: "CONFLICTED",
      } });
      if (!original || original.sourceChangesetId === body.sourceChangesetId || body.mode === "REVERT") {
        throw new SourceControlError(422, "INVALID_RESOLUTION", "Conflict resolutions require a new immutable changeset");
      }
    }
    const pending = await tx.changeIntegration.count({ where: { repositoryId,
      state: { in: ["QUEUED", "PREPARING", "WAITING_CHECKS", "WAITING_APPROVAL", "RETRY"] } } });
    if (pending >= Math.min(2000, repository.maxActivePullRequests)) {
      throw new SourceControlError(429, "INTEGRATION_QUOTA", "Repository integration queue capacity reached");
    }
    const created = await tx.changeIntegration.create({ data: {
      repositoryId, sourceChangesetId: body.sourceChangesetId, targetRef: body.targetRef,
      requestKey: body.requestKey, mode: body.mode ?? "MERGE",
      revertIntegrationId: body.revertIntegrationId ?? null, resolutionOfId: body.resolutionOfId ?? null,
      actorType: actor.type, actorId: actor.id, actorSessionId: actor.sessionId ?? null,
      actorCredentialId: actor.credentialId ?? null,
    } });
    await tx.auditEvent.create({ data: { repositoryId, actorType: actor.type, actorId: actor.id,
      action: "integration.queued", subjectId: created.id,
      metadata: { sourceChangesetId: body.sourceChangesetId, targetRef: body.targetRef,
        mode: created.mode, resolutionOfId: created.resolutionOfId } } });
    return created;
  });
}
async function setState(job: Integration, token: string, state: string, patch: {
  targetChangesetId?: string; baseChangesetId?: string; resultChangesetId?: string;
  targetGeneration?: number; affectedPaths?: string[]; conflicts?: Prisma.InputJsonValue;
  lastError?: string | null; completedAt?: Date; nextAttemptAt?: Date;
} = {}, action?: string) {
  await db.$transaction(async tx => {
    const changed = await tx.changeIntegration.updateMany({ where: {
      id: job.id, leaseToken: token, state: "PREPARING",
    }, data: { ...patch, state, leaseToken: null, leaseUntil: null } });
    if (changed.count !== 1) throw new SourceControlError(409, "LEASE_LOST", "Integration worker lease changed");
    if (action) await tx.auditEvent.create({ data: { repositoryId: job.repositoryId,
      actorType: "SYSTEM", actorId: "integration-worker", action,
      subjectId: job.id, metadata: {
        sourceChangesetId: job.sourceChangesetId, targetRef: job.targetRef,
        base: patch.baseChangesetId ?? null, target: patch.targetChangesetId ?? null,
        result: patch.resultChangesetId ?? null, affectedPaths: patch.affectedPaths ?? [],
        conflicts: patch.conflicts ?? null,
      } } });
  });
}
// Existing immutable content is safe to validate in parallel with unrelated changes.
// The completed, authenticated pipeline is rechecked under the final CAS transaction.
async function ensureStage(job: Integration, actor: SourceActor, stage: Stage): Promise<boolean> {
  const key = stageKey(job.id, stage);
  const pipeline = await db.validationPipeline.findUnique({ where: {
    repositoryId_idempotencyKey: { repositoryId: job.repositoryId, idempotencyKey: key },
  } });
  if (!pipeline) {
    await submitValidation(job.repositoryId, stage.subject, stage.target, key, actor);
    return false;
  }
  if (["FAILED", "ERRORED", "TIMED_OUT", "CANCELLED"].includes(pipeline.state)) {
    throw new SourceControlError(409, "VALIDATION_FAILED", "Integration stage " + stage.name + " failed execution validation");
  }
  if (pipeline.state !== "PASSED") return false;
  if (!await hasVerifiedChecks(job.repositoryId, stage.subject, stage.target)) {
    throw new SourceControlError(409, "VALIDATION_STALE", "Integration stage evidence is missing, stale or unauthenticated");
  }
  return true;
}
async function lockAndVerifyStage(tx: Prisma.TransactionClient, job: Integration, stage: Stage,
  expected: Awaited<ReturnType<typeof snapshotFor>>) {
  const key = stageKey(job.id, stage);
  const pipeline = await tx.validationPipeline.findUnique({ where: {
    repositoryId_idempotencyKey: { repositoryId: job.repositoryId, idempotencyKey: key },
  }, include: { tasks: true } });
  if (!pipeline || pipeline.state !== "PASSED" || pipeline.changesetId !== stage.subject ||
      pipeline.targetChangesetId !== stage.target) {
    throw new SourceControlError(409, "CHECKS_NOT_READY", "Exact signed integration checks are missing");
  }
  await tx.$queryRaw`SELECT id FROM "ValidationPipeline" WHERE id = ${pipeline.id}::uuid FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM "ValidationTask" WHERE "pipelineId" = ${pipeline.id}::uuid FOR SHARE`;
  // Never authorize from metadata-only SourceValidation rows.
  const current = recipes();
  if (pipeline.configurationDigest !== configurationDigest(current) || pipeline.tasks.length !== KINDS.length) {
    throw new SourceControlError(409, "CHECKS_NOT_READY", "Validation configuration or check count changed");
  }
  if (pipeline.snapshotDigest !== expected.digest || pipeline.dependencyDigest !== expected.dependencyDigest ||
      !current.every(recipe => {
        const task = pipeline.tasks.find(t => t.kind === recipe.kind);
        return task?.state === "PASSED" && task.exitCode === 0 && verifyTask(task) &&
          task.fingerprint === fingerprint(job.repositoryId, stage.subject, stage.target,
            expected.digest, expected.dependencyDigest, recipe);
      })) {
    throw new SourceControlError(409, "CHECKS_NOT_READY", "Missing, stale or unauthenticated validation evidence");
  }
}
async function guardApprovals(tx: Prisma.TransactionClient, job: Integration, resultId: string, protectedRef: boolean) {
  const repository = await tx.repository.findUniqueOrThrow({ where: { id: job.repositoryId } });
  const refPolicy = await tx.sourceReferencePolicy.findUnique({ where: {
    repositoryId_name: { repositoryId: job.repositoryId, name: job.targetRef },
  } });
  const sourceReview = await tx.sourceReview.findUnique({ where: { changesetId: job.sourceChangesetId } });
  const resultReview = await tx.sourceReview.findUnique({ where: { changesetId: resultId } });
  // Unknown risk is treated as high, not an implicit approval.
  const highRisk = !sourceReview || sourceReview.state !== "COMPLETED" ||
    !resultReview || resultReview.state !== "COMPLETED" ||
    ["HIGH", "CRITICAL"].includes(sourceReview.riskTier ?? "CRITICAL") ||
    ["HIGH", "CRITICAL"].includes(resultReview.riskTier ?? "CRITICAL");
  if (!(protectedRef || repository.requireHumanApproval || refPolicy?.requireApproval || highRisk)) return;
  const ids = [...new Set([job.sourceChangesetId, resultId])];
  for (const id of ids) {
    await tx.$queryRaw`SELECT "userId" FROM "SourceChangeApproval" WHERE "changesetId" = ${id} FOR SHARE`;
    const approval = await tx.sourceChangeApproval.findFirst({ where: { changesetId: id, decision: "APPROVED" } });
    if (!approval) throw new SourceControlError(409, "APPROVAL_MISSING", "Human approval is required for exact source and integrated revisions");
  }
}
async function publish(job: Integration, token: string, actor: SourceActor,
  observed: { changesetId: string; generation: number }, resultId: string,
  policy: Policy, protectedRef: boolean) {
  const stages: Stage[] = [
    { name: "pre", subject: job.sourceChangesetId, target: null },
    { name: "target", subject: resultId, target: observed.changesetId },
    { name: "post", subject: resultId, target: null },
  ];
  const evidence = await Promise.all(stages.map(stage =>
    snapshotFor(job.repositoryId, stage.subject, stage.target)));
  await db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Repository" WHERE id = ${job.repositoryId}::uuid FOR SHARE`;
    await assertRepositoryPermission(actor, job.repositoryId, "ref:update", { branch: job.targetRef }, tx);
    const repo = await tx.repository.findUniqueOrThrow({ where: { id: job.repositoryId } });
    await tx.$queryRaw`SELECT "repositoryId" FROM "SourceReferencePolicy"
      WHERE "repositoryId" = ${job.repositoryId}::uuid AND name = ${job.targetRef} FOR SHARE`;
    const configured = await tx.sourceReferencePolicy.findUnique({ where: {
      repositoryId_name: { repositoryId: job.repositoryId, name: job.targetRef },
    } });
    const updatedIntegrationPolicy = await tx.integrationPolicy.findUnique({ where: {
      repositoryId_targetRef: { repositoryId: job.repositoryId, targetRef: job.targetRef },
    } });
    const nowProtected = repo.defaultBranch === job.targetRef || configured?.protected === true;
    const requiredNow = {
      preChecks: nowProtected || (updatedIntegrationPolicy?.preChecks ?? true),
      targetChecks: nowProtected || (updatedIntegrationPolicy?.targetChecks ?? true),
      postChecks: nowProtected || (updatedIntegrationPolicy?.postChecks ?? true),
    };
    if ((requiredNow.preChecks && !policy.preChecks) ||
        (requiredNow.targetChecks && !policy.targetChecks) ||
        (requiredNow.postChecks && !policy.postChecks)) {
      throw new SourceControlError(409, "POLICY_CHANGED", "Integration policy became stricter during preparation");
    }
    const current = await tx.sourceReference.findUnique({ where: {
      repositoryId_name: { repositoryId: job.repositoryId, name: job.targetRef },
    } });
    if (!current || current.deletedAt || current.kind !== "BRANCH" ||
        current.generation !== observed.generation || current.changesetId !== observed.changesetId) {
      throw new SourceControlError(409, "TARGET_MOVED", "Target ref advanced during preparation");
    }
    if (!await isAncestor(tx, job.repositoryId, observed.changesetId, resultId)) {
      throw new SourceControlError(409, "NON_FAST_FORWARD", "Integrated revision must descend from observed target");
    }
    for (const [index, stage] of stages.entries()) {
      if ((stage.name === "pre" && policy.preChecks) ||
          (stage.name === "target" && policy.targetChecks) ||
          (stage.name === "post" && policy.postChecks)) await lockAndVerifyStage(tx, job, stage, evidence[index]);
    }
    await guardApprovals(tx, job, resultId, nowProtected);
    const claimed = await tx.changeIntegration.updateMany({ where: {
      id: job.id, leaseToken: token, state: "PREPARING",
    }, data: { state: "INTEGRATED", targetChangesetId: observed.changesetId,
      targetGeneration: observed.generation, resultChangesetId: resultId,
      leaseToken: null, leaseUntil: null, completedAt: new Date() } });
    if (claimed.count !== 1) throw new SourceControlError(409, "LEASE_LOST", "Worker lost exclusive integration claim");
    const moved = await tx.sourceReference.updateMany({ where: {
      repositoryId: job.repositoryId, name: job.targetRef, generation: observed.generation,
      changesetId: observed.changesetId, deletedAt: null,
    }, data: { changesetId: resultId, generation: { increment: 1 } } });
    if (moved.count !== 1) throw new SourceControlError(409, "TARGET_MOVED", "Ref CAS rejected stale target");
    const mutation = await tx.sourceRefMutation.create({ data: {
      repositoryId: job.repositoryId, name: job.targetRef, mutationId: "integration-" + job.id,
      requestHash: digest([job.id, observed.changesetId, observed.generation, resultId]),
      operation: "UPDATE", kind: "BRANCH", oldChangesetId: observed.changesetId,
      newChangesetId: resultId, oldGeneration: observed.generation, newGeneration: observed.generation + 1,
      actorType: actor.type, actorId: actor.id,
      reason: job.mode === "REVERT" ? "Audited inverse changeset" : "Validated concurrent integration",
    } });
    const payload = { eventId: mutation.id, repositoryId: job.repositoryId, name: job.targetRef,
      action: "UPDATE", oldChangesetId: observed.changesetId, newChangesetId: resultId,
      oldGeneration: observed.generation, newGeneration: observed.generation + 1,
      integrationId: job.id, mode: job.mode };
    await tx.outboxEvent.create({ data: { aggregateType: "SourceReference",
      aggregateId: job.repositoryId, kind: "source.ref.update", payload } });
    await tx.auditEvent.create({ data: { repositoryId: job.repositoryId,
      actorType: actor.type, actorId: actor.id, action: "integration.published",
      subjectId: job.id, metadata: { ...payload, protectedRef: nowProtected,
        checkedStages: stages.filter(s => policy[s.name === "pre" ? "preChecks" :
          s.name === "target" ? "targetChecks" : "postChecks"]).map(s => stageKey(job.id,s)) } } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 20000, timeout: 120000 });
}

export async function executeIntegration(jobId: string, lease: string) {
  const job = await db.changeIntegration.findUniqueOrThrow({ where: { id: jobId } });
  if (job.leaseToken !== lease || job.state !== "PREPARING") return;
  const actor = actorFrom(job);
  const ref = await db.sourceReference.findUnique({ where: {
    repositoryId_name: { repositoryId: job.repositoryId, name: job.targetRef },
  } });
  if (!ref || ref.deletedAt || ref.kind !== "BRANCH") {
    throw new SourceControlError(409, "TARGET_UNAVAILABLE", "Target branch is deleted or inaccessible");
  }
  await assertRepositoryPermission(actor, job.repositoryId, "ref:update", { branch: job.targetRef });
  const repo = await db.repository.findUniqueOrThrow({ where: { id: job.repositoryId } });
  const protectedPolicy = await db.sourceReferencePolicy.findUnique({ where: {
    repositoryId_name: { repositoryId: job.repositoryId, name: job.targetRef },
  } });
  const protectedRef = repo.defaultBranch === job.targetRef || protectedPolicy?.protected === true;
  const policy = await policyFor(job.repositoryId, job.targetRef, protectedRef);
  if (job.attempts >= Math.min(policy.maxRetries, job.maxAttempts)) {
    throw new SourceControlError(409, "RETRY_EXHAUSTED", "The target changed too many times");
  }
  let baseId: string;
  let incomingId: string;
  if (job.mode === "REVERT") {
    if (!job.revertIntegrationId) throw new SourceControlError(409, "INVALID_REVERT", "Missing exact source integration");
    const prior = await db.changeIntegration.findFirst({ where: {
      id: job.revertIntegrationId, repositoryId: job.repositoryId,
      state: "INTEGRATED", targetRef: job.targetRef,
    } });
    if (!prior?.resultChangesetId || !prior.targetChangesetId ||
        !await db.$transaction(tx => isAncestor(tx, job.repositoryId, prior.resultChangesetId!, ref.changesetId))) {
      throw new SourceControlError(409, "REVERT_BASE_MOVED", "Cannot revert a revision not present in this target history");
    }
    baseId = prior.resultChangesetId;
    incomingId = prior.targetChangesetId;
  } else {
    if (await db.$transaction(tx => isAncestor(tx, job.repositoryId, job.sourceChangesetId, ref.changesetId))) {
      await setState(job, lease, "SKIPPED", { targetChangesetId: ref.changesetId,
        targetGeneration: ref.generation, completedAt: new Date() }, "integration.already_present");
      return;
    }
    const bases = await runAuthorizedQuery(actor, job.repositoryId,
      () => mergeBases(job.repositoryId, ref.changesetId, job.sourceChangesetId));
    if (bases.length !== 1) {
      throw new SourceControlError(409, "AMBIGUOUS_MERGE_BASE", "Exactly one merge base is required for safe automatic integration");
    }
    baseId = bases[0];
    incomingId = job.sourceChangesetId;
  }
  const [base, ours, theirs] = await Promise.all([
    readCanonicalSnapshotForValidation(job.repositoryId, baseId),
    readCanonicalSnapshotForValidation(job.repositoryId, ref.changesetId),
    readCanonicalSnapshotForValidation(job.repositoryId, incomingId),
  ]);
  const plan = planIntegration(base.entries, ours.entries, theirs.entries);
  if (plan.conflicts.length) {
    await setState(job, lease, "CONFLICTED", {
      baseChangesetId: baseId, targetChangesetId: ref.changesetId,
      targetGeneration: ref.generation, affectedPaths: plan.affectedPaths,
      conflicts: plan.conflicts as unknown as Prisma.InputJsonValue,
    }, "integration.conflicted");
    return;
  }
  if (plan.operations.length > 200) {
    throw new SourceControlError(413, "DELTA_TOO_LARGE", "Integration changes more than 200 files; split into reviewed changesets");
  }
  await assertRepositoryPermission(actor, job.repositoryId, "changeset:write", { paths: plan.affectedPaths });
  const parents = job.sourceChangesetId === ref.changesetId ? [ref.changesetId] :
    [ref.changesetId, job.sourceChangesetId];
  const candidate = await createCanonicalChangeset(job.repositoryId, actor, {
    apiVersion: 2, parents, description: (job.mode === "REVERT" ? "Revert " : "Integrate ") +
      job.sourceChangesetId + " into " + job.targetRef,
    operations: plan.operations,
  });
  const stages: Stage[] = [
    { name: "pre", subject: job.sourceChangesetId, target: null },
    { name: "target", subject: candidate.id, target: ref.changesetId },
    { name: "post", subject: candidate.id, target: null },
  ];
  let pending = false;
  for (const stage of stages) {
    if ((stage.name === "pre" && policy.preChecks) ||
        (stage.name === "target" && policy.targetChecks) ||
        (stage.name === "post" && policy.postChecks)) {
      if (!await ensureStage(job, actor, stage)) pending = true;
    }
  }
  if (pending) {
    await setState(job, lease, "WAITING_CHECKS", { baseChangesetId: baseId,
      targetChangesetId: ref.changesetId, targetGeneration: ref.generation, resultChangesetId: candidate.id,
      affectedPaths: plan.affectedPaths, nextAttemptAt: seconds(15) }, "integration.checks_requested");
    return;
  }
  try {
    await publish(job, lease, actor, ref, candidate.id, policy, protectedRef);
  } catch (error) {
    if (error instanceof SourceControlError && error.code === "APPROVAL_MISSING") {
      await setState(job, lease, "WAITING_APPROVAL", {
        baseChangesetId: baseId, targetChangesetId: ref.changesetId,
        targetGeneration: ref.generation, resultChangesetId: candidate.id,
        affectedPaths: plan.affectedPaths, nextAttemptAt: seconds(15),
      }, "integration.approval_required");
      return;
    }
    throw error;
  }
}
export async function processNextIntegration(): Promise<boolean> {
  const now = new Date();
  const next = await db.changeIntegration.findFirst({ where: { OR: [
    { state: { in: ["QUEUED", "WAITING_CHECKS", "WAITING_APPROVAL", "RETRY"] }, nextAttemptAt: { lte: now } },
    { state: "PREPARING", leaseUntil: { lt: now } },
  ] }, orderBy: [{ nextAttemptAt: "asc" }, { id: "asc" }] });
  if (!next) return false;
  const token = randomUUID();
  const claimed = await db.changeIntegration.updateMany({ where: { id: next.id, state: next.state,
    leaseToken: next.leaseToken, ...(next.state === "PREPARING" ?
      { leaseUntil: { lt: now } } : { nextAttemptAt: { lte: now } }) },
    data: { state: "PREPARING", leaseToken: token, leaseUntil: seconds(600) } });
  if (!claimed.count) return true;
  try { await executeIntegration(next.id, token); }
  catch (error) {
    const code = error instanceof SourceControlError ? error.code : "INTERNAL_ERROR";
    const retry = code === "TARGET_MOVED" || code === "REFERENCE_CONFLICT";
    const wait = transient.has(code) && !retry;
    const state = retry && next.attempts + 1 < next.maxAttempts ? "RETRY" :
      wait ? "WAITING_CHECKS" : "FAILED";
    await db.$transaction(async tx => {
      const moved = await tx.changeIntegration.updateMany({ where: {
        id: next.id, state: "PREPARING", leaseToken: token,
      }, data: { state, leaseToken: null, leaseUntil: null,
        attempts: { increment: retry ? 1 : 0 },
        nextAttemptAt: seconds(retry ? Math.min(60, 2 ** (next.attempts + 1)) : 30),
        lastError: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
        ...(state === "FAILED" ? { completedAt: new Date() } : {}),
      } });
      if (moved.count) await tx.auditEvent.create({ data: {
        repositoryId: next.repositoryId, actorType: "SYSTEM", actorId: "integration-worker",
        action: "integration." + state.toLowerCase(), subjectId: next.id,
        metadata: { code, attempt: next.attempts + (retry ? 1 : 0) },
      } });
    });
    if (state === "FAILED") console.error("Integration failed:", next.id, error);
  }
  return true;
}
export async function reauthorizeIntegration(repositoryId: string, integrationId: string, actor: SourceActor) {
  const job = await db.changeIntegration.findFirst({ where: { id: integrationId, repositoryId } });
  if (!job) throw new SourceControlError(404, "NOT_FOUND", "Integration not found");
  await assertRepositoryPermission(actor, repositoryId, "ref:update", { branch: job.targetRef });
  if (!["FAILED", "WAITING_APPROVAL", "WAITING_CHECKS", "RETRY"].includes(job.state))
    throw new SourceControlError(409, "INVALID_STATE", "Only nonterminal integration jobs can be reauthorized");
  const result = await db.changeIntegration.update({ where: { id: integrationId }, data: {
    actorType: actor.type, actorId: actor.id, actorSessionId: actor.sessionId ?? null,
    actorCredentialId: actor.credentialId ?? null, state: "QUEUED",
    attempts: 0, leaseToken: null, leaseUntil: null, nextAttemptAt: new Date(), lastError: null,
  } });
  await db.auditEvent.create({ data: { repositoryId, actorType: actor.type, actorId: actor.id,
    action: "integration.reauthorized", subjectId: integrationId } });
  return result;
}
export async function deploymentGate(repositoryId: string, id: string, actor: SourceActor, request = false) {
  await assertRepositoryPermission(actor, repositoryId, request ? "changeset:write" : "source:read");
  const job = await db.changeIntegration.findFirst({ where: { id, repositoryId } });
  if (!job || job.state !== "INTEGRATED" || !job.resultChangesetId)
    throw new SourceControlError(409, "NOT_INTEGRATED", "Deployment is allowed only for an integrated revision");
  const ref = await db.sourceReference.findUnique({ where: {
    repositoryId_name: { repositoryId, name: job.targetRef },
  } });
  if (!ref || ref.changesetId !== job.resultChangesetId || ref.deletedAt) {
    throw new SourceControlError(409, "DEPLOYMENT_STALE", "Deployment requires the current exact branch revision");
  }
  const repo = await db.repository.findUniqueOrThrow({ where: { id: repositoryId } });
  const refPolicy = await db.sourceReferencePolicy.findUnique({ where: {
    repositoryId_name: { repositoryId, name: job.targetRef },
  } });
  const policy = await policyFor(repositoryId, job.targetRef,
    repo.defaultBranch === job.targetRef || refPolicy?.protected === true);
  if (!policy.deploymentChecks) return { ready: true, revision: job.resultChangesetId, required: false };
  const stage: Stage = { name: "deployment", subject: job.resultChangesetId, target: null };
  if (request) await submitValidation(repositoryId, stage.subject, null, stageKey(job.id, stage), actor);
  const pipeline = await db.validationPipeline.findUnique({ where: {
    repositoryId_idempotencyKey: { repositoryId, idempotencyKey: stageKey(job.id,stage) },
  } });
  const ready = pipeline?.state === "PASSED" &&
    await hasVerifiedChecks(repositoryId, stage.subject, null);
  if (ready) {
    await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Repository" WHERE id = ${repositoryId}::uuid FOR SHARE`;
      const current = await tx.sourceReference.findUniqueOrThrow({ where: {
        repositoryId_name: { repositoryId, name: job.targetRef },
      } });
      if (current.changesetId !== job.resultChangesetId || current.deletedAt)
        throw new SourceControlError(409, "DEPLOYMENT_STALE", "Branch changed before deployment authorization");
      await lockAndVerifyStage(tx, job, stage, await snapshotFor(repositoryId, stage.subject, stage.target));
      if (request) await tx.auditEvent.create({ data: {
        repositoryId, actorType: actor.type, actorId: actor.id, action: "deployment.validation.authorized",
        subjectId: job.id, metadata: { revision: job.resultChangesetId, pipelineId: pipeline!.id },
      } });
    });
  }
  return { ready: !!ready, revision: job.resultChangesetId, required: true,
    validationState: pipeline?.state ?? "NOT_REQUESTED", pipelineId: pipeline?.id ?? null };
}
export async function updateIntegrationPolicy(repositoryId: string, targetRef: string, actor: SourceActor,
  value: Policy) {
  validateRefName(targetRef);
  if (actor.type !== "HUMAN") throw new SourceControlError(403, "HUMAN_REQUIRED", "Human administration required");
  if (!Number.isSafeInteger(value.maxRetries) || value.maxRetries < 1 || value.maxRetries > 32) {
    throw new SourceControlError(422, "INVALID_POLICY", "Retries must be in range 1-32");
  }
  return db.$transaction(async tx => {
    await assertRepositoryPermission(actor, repositoryId, "admin", {}, tx);
    await tx.$queryRaw`SELECT id FROM "Repository" WHERE id = ${repositoryId}::uuid FOR UPDATE`;
    const repo = await tx.repository.findUniqueOrThrow({ where: { id: repositoryId } });
    const refPolicy = await tx.sourceReferencePolicy.findUnique({ where: {
      repositoryId_name: { repositoryId, name: targetRef },
    } });
    if ((repo.defaultBranch === targetRef || refPolicy?.protected) &&
        (!value.preChecks || !value.targetChecks || !value.postChecks || !value.deploymentChecks)) {
      throw new SourceControlError(403, "PROTECTED_POLICY", "Protected references must enforce every validation phase");
    }
    const saved = await tx.integrationPolicy.upsert({ where: {
      repositoryId_targetRef: { repositoryId, targetRef },
    }, create: { repositoryId, targetRef, ...value }, update: value });
    await tx.auditEvent.create({ data: { repositoryId, actorType: actor.type, actorId: actor.id,
      action: "integration.policy.updated", subjectId: targetRef, metadata: value } });
    return saved;
  });
}

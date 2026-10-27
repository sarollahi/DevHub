import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "../lib/prisma";
import { assertRepositoryPermission } from "../lib/authorization";
import { SourceControlError, type SourceActor } from "../source-control/contracts";
import { validateRefName } from "../source-control/refs";
import { snapshotFor } from "../validation/snapshot";
import { configurationDigest, fingerprint, KINDS, recipes, verifyTask } from "../validation/policy";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sha = /^[a-f0-9]{64}$/;
const key = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/;

/** Only initial creation of a configured protected branch is supported. Ref updates require integration. */
export async function bootstrapProtectedBranch(repositoryId: string, actor: SourceActor,
  input: { name: string; changesetId: string; mutationId: string }) {
  validateRefName(input.name);
  if (!sha.test(input.changesetId) || !key.test(input.mutationId))
    throw new SourceControlError(422, "INVALID_INPUT", "Exact changeset and stable mutation ID required");
  if (actor.type !== "HUMAN") throw new SourceControlError(403, "HUMAN_REQUIRED", "A human administrator must bootstrap protected refs");
  await assertRepositoryPermission(actor, repositoryId, "admin");
  await assertRepositoryPermission(actor, repositoryId, "ref:update", { branch: input.name });
  const snapshot = await snapshotFor(repositoryId, input.changesetId, null);
  let configured;
  try { configured = recipes(); }
  catch { throw new SourceControlError(409, "CHECKS_NOT_READY", "Pinned validation images are not configured"); }
  const hash = configurationDigest(configured);
  const expectedRequestHash = digest(["BOOTSTRAP", input.name, input.changesetId, input.mutationId]);
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Repository" WHERE id = ${repositoryId}::uuid FOR UPDATE`;
    await assertRepositoryPermission(actor, repositoryId, "admin", {}, tx);
    await assertRepositoryPermission(actor, repositoryId, "ref:update", { branch: input.name }, tx);
    const repo = await tx.repository.findUniqueOrThrow({ where: { id: repositoryId } });
    const policy = await tx.sourceReferencePolicy.findUnique({ where: {
      repositoryId_name: { repositoryId, name: input.name },
    } });
    if (repo.defaultBranch !== input.name && policy?.protected !== true) {
      throw new SourceControlError(409, "NOT_PROTECTED", "Only protected refs can be bootstrapped with this endpoint");
    }
    const past = await tx.sourceRefMutation.findUnique({ where: {
      repositoryId_name_mutationId: { repositoryId, name: input.name, mutationId: input.mutationId },
    } });
    if (past) {
      if (past.requestHash !== expectedRequestHash) throw new SourceControlError(409, "MUTATION_ID_REUSED", "Bootstrap key already used");
      return { changesetId: past.newChangesetId, generation: past.newGeneration, replayed: true };
    }
    if (await tx.sourceReference.findUnique({ where: { repositoryId_name: { repositoryId, name: input.name } } })) {
      throw new SourceControlError(409, "REFERENCE_CONFLICT", "Protected ref already exists");
    }
    const change = await tx.sourceChangeset.findFirst({ where: { repositoryId, id: input.changesetId },
      include: { validation: true, review: true } });
    if (!change || change.validation?.state !== "SUCCESS" || change.review?.state !== "COMPLETED") {
      throw new SourceControlError(409, "REVIEW_REQUIRED", "Published changeset must have completed structural validation and review");
    }
    const approval = await tx.sourceChangeApproval.findFirst({ where: {
      changesetId: input.changesetId, decision: "APPROVED",
    } });
    if (!approval) throw new SourceControlError(403, "HUMAN_APPROVAL_REQUIRED", "Exact bootstrapped revision requires human approval");
    const pipeline = await tx.validationPipeline.findFirst({ where: {
      repositoryId, changesetId: input.changesetId, targetChangesetId: null,
      state: "PASSED", configurationDigest: hash, snapshotDigest: snapshot.digest,
      dependencyDigest: snapshot.dependencyDigest,
    }, include: { tasks: true }, orderBy: { createdAt: "desc" } });
    if (!pipeline || pipeline.tasks.length !== KINDS.length) {
      throw new SourceControlError(409, "CHECKS_NOT_READY", "All exact signed validation checks must pass before bootstrap");
    }
    await tx.$queryRaw`SELECT id FROM "ValidationPipeline" WHERE id = ${pipeline.id}::uuid FOR SHARE`;
    await tx.$queryRaw`SELECT id FROM "ValidationTask" WHERE "pipelineId" = ${pipeline.id}::uuid FOR SHARE`;
    if (!configured.every(recipe => {
      const task = pipeline.tasks.find(t => t.kind === recipe.kind);
      return !!task && task.state === "PASSED" && task.exitCode === 0 &&
        verifyTask(task) && task.fingerprint === fingerprint(repositoryId, input.changesetId,
          null, snapshot.digest, snapshot.dependencyDigest, recipe);
    })) throw new SourceControlError(409, "CHECKS_NOT_READY", "Invalid or unauthenticated bootstrap checks");
    await tx.sourceReference.create({ data: {
      repositoryId, name: input.name, changesetId: input.changesetId, kind: "BRANCH", generation: 1,
    } });
    const mutation = await tx.sourceRefMutation.create({ data: {
      repositoryId, name: input.name, mutationId: input.mutationId,
      requestHash: expectedRequestHash, operation: "CREATE", kind: "BRANCH",
      oldChangesetId: null, newChangesetId: input.changesetId, oldGeneration: null,
      newGeneration: 1, actorType: "HUMAN", actorId: actor.id,
      reason: "Signed and approved protected-branch bootstrap",
    } });
    const payload = { repositoryId, name: input.name, action: "CREATE",
      oldChangesetId: null, newChangesetId: input.changesetId,
      oldGeneration: null, newGeneration: 1, eventId: mutation.id };
    await tx.auditEvent.create({ data: { repositoryId, actorType: "HUMAN", actorId: actor.id,
      action: "reference.protected_bootstrap", subjectId: input.changesetId,
      metadata: { ...payload, pipelineId: pipeline.id, approvalUserId: approval.userId } } });
    await tx.outboxEvent.create({ data: {
      aggregateType: "SourceReference", aggregateId: repositoryId, kind: "source.ref.create", payload,
    } });
    return { changesetId: input.changesetId, generation: 1, replayed: false };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 30000 });
}

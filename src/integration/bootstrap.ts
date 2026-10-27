import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "../lib/prisma";
import { assertRepositoryPermission } from "../lib/authorization";
import { SourceControlError, type SourceActor } from "../source-control/contracts";
import { validateRefName } from "../source-control/refs";
import { assertSignedProtectedTip } from "./protected-evidence";

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
    const evidence = await assertSignedProtectedTip(tx, repositoryId, input.changesetId);
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
      metadata: { ...payload, pipelineId: evidence.pipelineId, approvalUserId: evidence.approvalUserId } } });
    await tx.outboxEvent.create({ data: {
      aggregateType: "SourceReference", aggregateId: repositoryId, kind: "source.ref.create", payload,
    } });
    return { changesetId: input.changesetId, generation: 1, replayed: false };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 30000 });
}

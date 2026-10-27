import { createHash, randomUUID } from "node:crypto";
import { Prisma, type SourceRefKind } from "@prisma/client";
import { db } from "../lib/prisma";
import { SourceControlError, type SourceActor } from "./contracts";
import { assertRepositoryPermission } from "../lib/authorization";

export type RefOperation = "CREATE" | "UPDATE" | "DELETE" | "RESTORE";
export type RefMutationRequest = {
  name: string;
  operation: RefOperation;
  mutationId: string;
  expectedGeneration: number | null;
  changesetId?: string;
  expectedChangesetId?: string;
  kind?: SourceRefKind;
  force?: boolean;
  reason?: string;
};
const sha = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const digest = /^[0-9a-f]{64}$/;
const namePart = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const uuidOrKey = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

export function validateRefName(name: string): void {
  if (name.length > 200 || !name || name.startsWith("/") || name.endsWith("/") ||
      name.includes("//") || name.includes("..") || name.includes("@{") ||
      name.split("/").some(part => !namePart.test(part) || part.endsWith(".") ||
        part.endsWith(".lock") || part === "." || part === "..")) {
    throw new SourceControlError(422, "INVALID_REFERENCE", "Invalid reference name");
  }
}

export function refKindFor(name: string, requested?: SourceRefKind): SourceRefKind {
  const prefix = name.startsWith("tags/") ? "TAG" : name.startsWith("releases/") ? "RELEASE" : "BRANCH";
  if (requested && requested !== prefix) {
    throw new SourceControlError(422, "INVALID_REFERENCE_KIND", "Reference namespace and kind disagree");
  }
  return prefix;
}

export function validateMutation(input: RefMutationRequest): void {
  validateRefName(input.name);
  if (!uuidOrKey.test(input.mutationId)) throw new SourceControlError(422, "INVALID_MUTATION_ID", "Provide a stable mutationId (1–128 safe characters)");
  if (input.expectedGeneration !== null && (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 1)) {
    throw new SourceControlError(422, "INVALID_GENERATION", "Expected generation must be a positive integer or null");
  }
  if (input.changesetId !== undefined && !digest.test(input.changesetId)) {
    throw new SourceControlError(422, "INVALID_CHANGESET", "Changeset ID must be SHA-256");
  }
  if (input.expectedChangesetId !== undefined && !digest.test(input.expectedChangesetId)) {
    throw new SourceControlError(422, "INVALID_CHANGESET", "Expected changeset ID must be SHA-256");
  }
  if (input.operation === "CREATE" && input.expectedGeneration !== null) {
    throw new SourceControlError(422, "INVALID_GENERATION", "Creation requires expectedGeneration: null");
  }
  if (input.operation !== "CREATE" && input.expectedGeneration === null) {
    throw new SourceControlError(422, "INVALID_GENERATION", "Mutation requires the observed generation");
  }
  if (input.operation === "DELETE" && input.changesetId) {
    throw new SourceControlError(422, "INVALID_INPUT", "Delete does not accept a new changeset");
  }
  if (input.operation !== "DELETE" && !input.changesetId) {
    throw new SourceControlError(422, "INVALID_CHANGESET", "Changeset ID is required");
  }
  if (input.force && (input.operation === "CREATE" || input.operation === "DELETE")) {
    throw new SourceControlError(422, "INVALID_FORCE", "Force applies to existing target changes only");
  }
  if (input.force && (!input.reason || input.reason.trim().length < 10)) {
    throw new SourceControlError(422, "FORCE_REASON_REQUIRED", "Force updates require a reason of at least 10 characters");
  }
}

// A changeset can exist without any ref. The graph query is read in the same
// transaction as the CAS and walks parent edges, never materializing snapshots.
export async function isAncestor(tx: Prisma.TransactionClient, repositoryId: string, ancestor: string, descendant: string): Promise<boolean> {
  if (ancestor === descendant) return true;
  const matches = await tx.$queryRaw<{ found: boolean }[]>`
    WITH RECURSIVE ancestors(id) AS (
      SELECT ${descendant}::text
      UNION
      SELECT edge."parentId"::text
      FROM "SourceChangesetParent" edge
      JOIN ancestors ON edge."changesetId" = ancestors.id
      JOIN "SourceChangeset" parent ON parent.id = edge."parentId"
      WHERE parent."repositoryId" = ${repositoryId}::uuid
    )
    SELECT EXISTS (SELECT 1 FROM ancestors WHERE id = ${ancestor}::text) AS found
  `;
  return matches[0]?.found === true;
}

function snapshot(m: {
  repositoryId: string; name: string; newChangesetId: string | null;
  newGeneration: number; kind: SourceRefKind; operation: string; mutationId: string;
  createdAt: Date;
}) {
  return {
    repositoryId: m.repositoryId, name: m.name, changesetId: m.newChangesetId,
    generation: m.newGeneration, kind: m.kind, deleted: m.operation === "DELETE",
    updatedAt: m.createdAt,
  };
}

export async function mutateReference(repositoryId: string, actor: SourceActor, input: RefMutationRequest) {
  validateMutation(input);
  await assertRepositoryPermission(actor, repositoryId, "ref:update", { branch: input.name });
  if (input.force) await assertRepositoryPermission(actor, repositoryId, "admin");
  const hash = sha([input.operation, input.name, input.mutationId, input.expectedGeneration,
    input.expectedChangesetId ?? null, input.changesetId ?? null, input.kind ?? null,
    !!input.force, input.reason?.trim() ?? null]);
  const byMutation = { repositoryId_name_mutationId: { repositoryId, name: input.name, mutationId: input.mutationId } };
  const replay = async () => {
    const old = await db.sourceRefMutation.findUnique({ where: byMutation });
    if (!old) return null;
    if (old.requestHash !== hash) throw new SourceControlError(409, "MUTATION_ID_REUSED", "Mutation ID was previously used with different content");
    return { ref: snapshot(old), replayed: true, eventId: old.id };
  };
  const existing = await replay();
  if (existing) return existing;
  const transact = async () => db.$transaction(async tx => {
    await assertRepositoryPermission(actor, repositoryId, "ref:update", { branch: input.name }, tx);
    if (input.force) await assertRepositoryPermission(actor, repositoryId, "admin", {}, tx);
    // Recheck inside the transaction. Unique constraints close the simultaneous
    // first-request race, and the catch below resolves equivalent retries.
    const priorRequest = await tx.sourceRefMutation.findUnique({ where: byMutation });
    if (priorRequest) {
      if (priorRequest.requestHash !== hash) throw new SourceControlError(409, "MUTATION_ID_REUSED", "Mutation ID reused");
      return { ref: snapshot(priorRequest), replayed: true, eventId: priorRequest.id };
    }
    const repo = await tx.repository.findUnique({ where: { id: repositoryId }, select: {
      defaultBranch: true, ownerId: true, requireHumanApproval: true,
    } });
    if (!repo) throw new SourceControlError(404, "REPOSITORY_NOT_FOUND", "Repository not found");
    // Policy authorization is checked inside this transaction; ownership does not imply global access.
    const current = await tx.sourceReference.findUnique({ where: { repositoryId_name: { repositoryId, name: input.name } } });
    const kind = input.operation === "CREATE" ? refKindFor(input.name, input.kind) : current?.kind;
    if (current && input.kind && input.kind !== current.kind) throw new SourceControlError(409, "REFERENCE_KIND_CONFLICT", "Reference kind is immutable");
    if (!kind) throw new SourceControlError(409, "REFERENCE_CONFLICT", "Reference does not exist");
    if (kind === "TAG" && input.operation !== "CREATE") {
      throw new SourceControlError(403, "IMMUTABLE_TAG", "Tags cannot be updated, deleted or restored");
    }
    const isDefault = input.name === repo.defaultBranch;
    if (isDefault && kind !== "BRANCH") throw new SourceControlError(422, "INVALID_REFERENCE_KIND", "Default branch must be a branch");
    const policy = await tx.sourceReferencePolicy.findUnique({ where: { repositoryId_name: { repositoryId, name: input.name } } });
    const protectedRef = isDefault || policy?.protected === true;
    // Existing protected refs can advance only through the integration service.
    // The legacy direct ref path checks manifest validity, not signed execution
    // evidence for the merged snapshot, so allowing it would bypass the gate.
    if ((input.operation === "CREATE" || input.operation === "UPDATE" || input.operation === "RESTORE") && protectedRef && !input.force) {
      throw new SourceControlError(403, "INTEGRATION_REQUIRED", "Protected refs require validated integration");
    }
    if ((protectedRef || isDefault) && input.force) throw new SourceControlError(403, "PROTECTED_REFERENCE", "Force updates are forbidden on protected references");
    if (input.operation === "DELETE" && (protectedRef || policy?.allowDelete === false)) {
      throw new SourceControlError(403, "PROTECTED_REFERENCE", "Deleting this reference is forbidden");
    }
    if (input.force && (!policy?.allowForce || protectedRef)) {
      throw new SourceControlError(403, "FORCE_FORBIDDEN", "Explicit force permission is required");
    }
    const oldGeneration = current?.generation ?? null;
    const oldId = current?.changesetId ?? null;
    if (input.operation === "CREATE" ? !!current : (!current || current.generation !== input.expectedGeneration)) {
      throw new SourceControlError(409, "REFERENCE_CONFLICT", "Reference version changed; reread before retrying");
    }
    if (input.expectedChangesetId && oldId !== input.expectedChangesetId) {
      throw new SourceControlError(409, "REFERENCE_CONFLICT", "Reference target changed");
    }
    if (input.operation === "UPDATE" && current?.deletedAt) {
      throw new SourceControlError(409, "REFERENCE_DELETED", "Deleted reference requires explicit restore");
    }
    if (input.operation === "RESTORE" && !current?.deletedAt) {
      throw new SourceControlError(409, "REFERENCE_ACTIVE", "Only a deleted reference can be restored");
    }
    if (input.operation === "DELETE" && current?.deletedAt) {
      throw new SourceControlError(409, "REFERENCE_DELETED", "Reference already deleted");
    }
    const target = input.operation === "DELETE" ? oldId : input.changesetId!;
    if (input.operation !== "DELETE") {
      const changeset = await tx.sourceChangeset.findFirst({ where: { id: target!, repositoryId }, include: { validation: true } });
      if (!changeset) throw new SourceControlError(404, "CHANGESET_NOT_FOUND", "Target changeset not in repository");
      if (changeset.validation?.state !== "SUCCESS") throw new SourceControlError(409, "VALIDATION_REQUIRED", "Changeset integrity validation required");
      if (repo.requireHumanApproval || protectedRef || policy?.requireApproval) {
        const approval = await tx.sourceChangeApproval.findFirst({ where: {
          changesetId: target!, decision: "APPROVED",
        } });
        if (approval?.decision !== "APPROVED") {
          throw new SourceControlError(403, "HUMAN_APPROVAL_REQUIRED", "Owner approval required");
        }
      }
      if (current && oldId !== target && !(await isAncestor(tx, repositoryId, oldId!, target!)) && !input.force) {
        throw new SourceControlError(409, "NON_FAST_FORWARD", "Target does not descend from the current changeset");
      }
    }
    const newGeneration = (oldGeneration ?? 0) + 1;
    const now = new Date();
    if (input.operation === "CREATE") {
      await tx.sourceReference.create({ data: {
        repositoryId, name: input.name, changesetId: target!, kind, generation: 1,
      } });
    } else {
      const moved = await tx.sourceReference.updateMany({
        where: { repositoryId, name: input.name, generation: input.expectedGeneration!, 
          deletedAt: input.operation === "RESTORE" ? { not: null } : null },
        data: { changesetId: target!, generation: { increment: 1 },
          deletedAt: input.operation === "DELETE" ? now : null },
      });
      if (moved.count !== 1) throw new SourceControlError(409, "REFERENCE_CONFLICT", "Stale reference generation");
    }
    const mutation = await tx.sourceRefMutation.create({ data: {
      repositoryId, name: input.name, mutationId: input.mutationId,
      requestHash: hash, operation: input.operation, kind,
      oldChangesetId: oldId, newChangesetId: input.operation === "DELETE" ? null : target!,
      oldGeneration, newGeneration, actorType: actor.type, actorId: actor.id,
      forced: !!input.force, reason: input.reason?.trim() ?? null,
    } });
    const payload = { apiVersion: 1, eventId: mutation.id, repositoryId, name: input.name,
      action: input.operation, kind, oldChangesetId: oldId,
      newChangesetId: input.operation === "DELETE" ? null : target,
      oldGeneration, newGeneration, forced: !!input.force };
    await tx.auditEvent.create({ data: { repositoryId, actorType: actor.type, actorId: actor.id,
      action: `reference.${input.operation.toLowerCase()}`, subjectId: target,
      metadata: payload } });
    await tx.outboxEvent.create({ data: {
      aggregateType: "SourceReference", aggregateId: repositoryId,
      kind: `source.ref.${input.operation.toLowerCase()}`, payload,
    } });
    return { ref: snapshot(mutation), replayed: false, eventId: mutation.id };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, maxWait: 15000, timeout: 30000 });
  // The only automatic retry is a PostgreSQL serialization/deadlock failure.
  // Version conflicts are never retried against a newer version.
  for (let i = 0; i < 3; i++) {
    try { return await transact(); }
    catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        const committed = await replay();
        if (committed) return committed;
        throw new SourceControlError(409, "REFERENCE_CONFLICT", "Reference was concurrently changed");
      }
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2034" && i < 2) continue;
      throw err;
    }
  }
  throw new Error("Unreachable transaction retry state");
}

export async function listReferences(repositoryId: string, includeDeleted = false, actor?: SourceActor) {
  if (!actor) throw new SourceControlError(401, "UNAUTHORIZED", "Authentication required");
  await assertRepositoryPermission(actor, repositoryId, "source:read");
  return db.sourceReference.findMany({
    where: { repositoryId, ...(includeDeleted ? {} : { deletedAt: null }) }, orderBy: { name: "asc" },
  });
}

export async function referenceHistory(repositoryId: string, name: string, limit = 100, before?: number, actor?: SourceActor) {
  validateRefName(name);
  if (!actor) throw new SourceControlError(401, "UNAUTHORIZED", "Authentication required");
  await assertRepositoryPermission(actor, repositoryId, "source:read");
  return db.sourceRefMutation.findMany({
    where: { repositoryId, name, ...(before ? { newGeneration: { lt: before } } : {}) },
    orderBy: { newGeneration: "desc" }, take: Math.max(1, Math.min(200, limit)),
  });
}

export async function updateReferencePolicy(repositoryId: string, actor: SourceActor, name: string, policy: {
  protected: boolean; allowForce: boolean; allowDelete: boolean; requireApproval: boolean;
}) {
  validateRefName(name);
  return db.$transaction(async tx => {
    await assertRepositoryPermission(actor, repositoryId, "admin", {}, tx);
    await tx.$queryRaw`SELECT id FROM "Repository" WHERE id = ${repositoryId}::uuid FOR UPDATE`;
    const repo = await tx.repository.findUnique({ where: { id: repositoryId } });
    if (!repo) throw new SourceControlError(404, "REPOSITORY_NOT_FOUND", "Repository not found");
    if (actor.type !== "HUMAN") throw new SourceControlError(403, "HUMAN_REQUIRED", "Human administrator required");
    if (name === repo.defaultBranch && (!policy.protected || policy.allowForce || policy.allowDelete || !policy.requireApproval)) {
      throw new SourceControlError(403, "DEFAULT_BRANCH_PROTECTED", "Default branch must remain protected and require approval");
    }
    if (name.startsWith("tags/") && (policy.allowForce || policy.allowDelete)) {
      throw new SourceControlError(403, "IMMUTABLE_TAG", "Tags are always immutable");
    }
    const saved = await tx.sourceReferencePolicy.upsert({
      where: { repositoryId_name: { repositoryId, name } },
      create: { repositoryId, name, ...policy }, update: policy,
    });
    await tx.auditEvent.create({ data: { repositoryId, actorType: "HUMAN", actorId: actor.id,
      action: "reference.policy.updated", subjectId: name, metadata: policy } });
    return saved;
  });
}

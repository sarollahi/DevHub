import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "../lib/prisma";
import { validPath } from "../lib/review-logic";
import { changesetInputSchema, SourceControlError, type SourceActor, type FileOperation, type ChangesetReceipt } from "./contracts";
import { decodeBlob, decodeTree, encodeTree, objectId } from "./storage";
import { deriveChangesetMetadata } from "./derived";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const refName = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

export async function createChangeset(repositoryId: string, actor: SourceActor, body: unknown): Promise<ChangesetReceipt> {
  const parsed = changesetInputSchema.safeParse(body);
  if (!parsed.success) throw new SourceControlError(422, "INVALID_INPUT", parsed.error.issues.map(i => i.message).join("; "));
  const input = parsed.data;
  if (new Set(input.parents).size !== input.parents.length) throw new SourceControlError(422, "DUPLICATE_PARENT", "Parent IDs must be distinct");
  const writes = new Map<string, Buffer>();
  const operations: FileOperation[] = [];
  const changedPaths = new Set<string>();
  for (const operation of input.operations) {
    if (changedPaths.has(operation.path)) throw new SourceControlError(422, "DUPLICATE_PATH", "Each destination path may be modified once");
    changedPaths.add(operation.path);
    if (operation.kind === "PUT") {
      const data = decodeBlob(operation.dataBase64);
      const id = objectId("BLOB", data);
      writes.set(id, data);
      operations.push({ kind: "PUT", path: operation.path, objectId: id });
    } else if (operation.kind === "MOVE") {
      if (operation.path === operation.previousPath) throw new SourceControlError(422, "INVALID_MOVE", "A move must change its path");
      operations.push({ kind: "MOVE", path: operation.path, previousPath: operation.previousPath });
    } else {
      operations.push({ kind: "DELETE", path: operation.path });
    }
  }
  const result = await db.$transaction(async (tx) => {
    const repository = await tx.repository.findUnique({ where: { id: repositoryId }, select: { id: true } });
    if (!repository) throw new SourceControlError(404, "REPOSITORY_NOT_FOUND", "Unknown repository");
    const parents = await tx.sourceChangeset.findMany({ where: { id: { in: input.parents }, repositoryId }, select: { id: true, treeId: true } });
    if (parents.length !== input.parents.length) throw new SourceControlError(422, "UNKNOWN_PARENT", "Parent not found in this repository");
    const baseId = input.parents[0];
    const tree = baseId ? await tx.sourceObject.findUnique({ where: { id: parents.find(p => p.id === baseId)!.treeId } }) : null;
    if (tree && tree.kind !== "TREE") throw new Error("Parent references a non-tree object");
    const manifest = new Map((tree ? decodeTree(tree.data, tree.id) : []).map(e => [e.path, e.objectId]));
    for (const operation of operations) {
      if (operation.kind === "PUT") {
        manifest.set(operation.path, operation.objectId!);
      } else if (operation.kind === "DELETE") {
        if (!manifest.delete(operation.path)) throw new SourceControlError(409, "MISSING_SOURCE", `Cannot delete missing path: ${operation.path}`);
      } else {
        const source = manifest.get(operation.previousPath!);
        if (!source) throw new SourceControlError(409, "MISSING_SOURCE", `Cannot move missing path: ${operation.previousPath}`);
        if (manifest.has(operation.path)) throw new SourceControlError(409, "DESTINATION_EXISTS", `Move destination already exists: ${operation.path}`);
        manifest.delete(operation.previousPath!);
        manifest.set(operation.path, source);
        operation.objectId = source;
      }
    }
    const treeBytes = encodeTree([...manifest].map(([path, id]) => ({ path, objectId: id })));
    const treeId = objectId("TREE", treeBytes);
    const id = sha256(JSON.stringify([1, repositoryId, input.parents, treeId, actor.id, input.message, operations]));
    const existing = await tx.sourceChangeset.findUnique({ where: { id } });
    if (existing) return { id, treeId: existing.treeId, created: false };
    const blobs = [...writes].map(([id, data]) => ({ id, kind: "BLOB" as const, data, byteSize: data.length }));
    await tx.sourceObject.createMany({ data: [...blobs, { id: treeId, kind: "TREE" as const, data: treeBytes, byteSize: treeBytes.length }], skipDuplicates: true });
    const metadata = deriveChangesetMetadata(operations);
    await tx.sourceChangeset.create({ data: {
      id, repositoryId, treeId, authorId: `${actor.type}:${actor.id}`, message: input.message,
      parents: { create: input.parents.map((parentId, position) => ({ parentId, position })) },
      operations: { create: operations.map(op => ({ kind: op.kind, path: op.path, previousPath: op.previousPath, objectId: op.objectId })) },
      validation: { create: { state: "SUCCESS", ...metadata } },
    } });
    await tx.auditEvent.create({ data: { repositoryId, actorType: actor.type, actorId: actor.id,
      action: "changeset.created", subjectId: id, metadata: { treeId, parentCount: input.parents.length, operationCount: operations.length } } });
    return { id, treeId, created: true };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 20000, maxWait: 15000 }).catch(async error => {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      // Concurrent delivery of an identical immutable changeset is an idempotent replay.
      // Its descriptor contains all author, parent, tree and operation inputs.
      const known = await db.sourceChangeset.findMany({ where: { repositoryId }, orderBy: { createdAt: "desc" }, take: 20 });
      // Unrelated unique collisions must propagate instead of masquerading as success.
      if (known.length) throw new SourceControlError(409, "RETRY_SAME_CHANGESET", "Concurrent insert conflict; retry the identical request");
    }
    throw error;
  });
  return result;
}

export async function listChangesets(repositoryId: string, limit = 30) {
  return db.sourceChangeset.findMany({ where: { repositoryId }, take: Math.min(100, Math.max(1, limit)), orderBy: { createdAt: "desc" },
    include: { parents: { orderBy: { position: "asc" } }, operations: true, validation: true, approvals: true } });
}

export async function getChangeset(repositoryId: string, id: string) {
  return db.sourceChangeset.findFirst({ where: { repositoryId, id },
    include: { parents: { orderBy: { position: "asc" } }, operations: true, validation: true, approvals: true } });
}

export async function getTree(repositoryId: string, changesetId: string) {
  const change = await db.sourceChangeset.findFirst({ where: { repositoryId, id: changesetId },
    include: { tree: true } });
  if (!change) throw new SourceControlError(404, "NOT_FOUND", "Changeset not found");
  return { changesetId: change.id, treeId: change.treeId, entries: decodeTree(change.tree.data, change.treeId) };
}

export async function getObject(repositoryId: string, id: string) {
  const reachable = await db.sourceChangeset.findFirst({ where: {
    repositoryId, OR: [{ treeId: id }, { operations: { some: { objectId: id } } }],
  }, select: { id: true } });
  if (!reachable) throw new SourceControlError(404, "NOT_FOUND", "Object not found in repository history");
  const object = await db.sourceObject.findUnique({ where: { id } });
  if (!object || objectId(object.kind, object.data) !== object.id) throw new Error("Stored object failed integrity verification");
  return { id: object.id, kind: object.kind, byteSize: object.byteSize, dataBase64: Buffer.from(object.data).toString("base64") };
}

export async function approveChangeset(repositoryId: string, id: string, ownerId: string) {
  const changed = await db.$transaction(async tx => {
    const change = await tx.sourceChangeset.findFirst({ where: { repositoryId, id }, include: { validation: true } });
    if (!change) throw new SourceControlError(404, "NOT_FOUND", "Changeset not found");
    if (change.validation?.state !== "SUCCESS") throw new SourceControlError(409, "VALIDATION_REQUIRED", "Integrity validation must pass");
    await tx.sourceChangeApproval.upsert({ where: { changesetId_userId: { changesetId: id, userId: ownerId } },
      create: { changesetId: id, userId: ownerId, decision: "APPROVED" },
      update: { decision: "APPROVED" } });
    await tx.auditEvent.create({ data: { repositoryId, actorType: "HUMAN", actorId: ownerId, action: "changeset.approved", subjectId: id } });
    return { id, approved: true };
  });
  return changed;
}

export async function advanceReference(repositoryId: string, name: string, changesetId: string, expectedGeneration: number | null, actorId: string) {
  if (!validPath(name) || !refName.test(name) || name.endsWith(".lock") || name.includes("..")) {
    throw new SourceControlError(422, "INVALID_REFERENCE", "Invalid reference name");
  }
  if (expectedGeneration !== null && (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1)) {
    throw new SourceControlError(422, "INVALID_GENERATION", "Expected generation must be a positive integer or null");
  }
  return db.$transaction(async tx => {
    const repo = await tx.repository.findUnique({ where: { id: repositoryId } });
    if (!repo) throw new SourceControlError(404, "REPOSITORY_NOT_FOUND", "Repository not found");
    const changeset = await tx.sourceChangeset.findFirst({ where: { id: changesetId, repositoryId }, include: { validation: true } });
    if (!changeset) throw new SourceControlError(404, "CHANGESET_NOT_FOUND", "Changeset not found in this repository");
    if (changeset.validation?.state !== "SUCCESS") throw new SourceControlError(409, "VALIDATION_REQUIRED", "Integrity validation not successful");
    if (repo.requireHumanApproval) {
      const approval = await tx.sourceChangeApproval.findUnique({ where: { changesetId_userId: { changesetId, userId: repo.ownerId } } });
      if (approval?.decision !== "APPROVED") throw new SourceControlError(403, "HUMAN_APPROVAL_REQUIRED", "Owner approval required before updating a reference");
    }
    if (expectedGeneration === null) {
      const existing = await tx.sourceReference.findUnique({ where: { repositoryId_name: { repositoryId, name } } });
      if (existing) throw new SourceControlError(409, "REFERENCE_CONFLICT", "Reference already exists");
      await tx.sourceReference.create({ data: { repositoryId, name, changesetId, generation: 1 } });
    } else {
      const update = await tx.sourceReference.updateMany({ where: { repositoryId, name, generation: expectedGeneration },
        data: { changesetId, generation: { increment: 1 } } });
      if (update.count !== 1) throw new SourceControlError(409, "REFERENCE_CONFLICT", "Reference generation changed; read current value");
    }
    await tx.auditEvent.create({ data: { repositoryId, actorType: "HUMAN", actorId, action: "reference.advanced", subjectId: changesetId,
      metadata: { name, previousGeneration: expectedGeneration } } });
    return tx.sourceReference.findUniqueOrThrow({ where: { repositoryId_name: { repositoryId, name } } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

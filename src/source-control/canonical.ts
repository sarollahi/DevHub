import { createHash } from "node:crypto";
import { posix } from "node:path";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "../lib/prisma";
import { validPath } from "../lib/review-logic";
import { SourceControlError, type SourceActor } from "./contracts";
import { decodeTree, objectId } from "./storage";
import { deriveChangesetMetadata } from "./derived";
import { assertRepositoryPermission } from "../lib/authorization";
import { verifiedBlobStream } from "../object-store/service";
import { SnapshotTree, publishedSnapshotRoot, type SnapshotEntry } from "./snapshot-tree";
import { legacyRoot, advanceSnapshotBuild } from "./snapshot-backfill";

const digest = (data: string) => createHash("sha256").update(data).digest("hex");
const id = z.string().regex(/^[a-f0-9]{64}$/);
const path = z.string().max(512).refine(validPath, "Invalid relative path");
const mode = z.enum(["100644", "100755", "120000"]);
const operation = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ADD"), path, objectId: id, mode: mode.default("100644") }).strict(),
  z.object({ kind: z.literal("MODIFY"), path, objectId: id, mode: mode.optional() }).strict(),
  z.object({ kind: z.literal("DELETE"), path }).strict(),
  z.object({ kind: z.literal("RENAME"), path, previousPath: path }).strict(),
  z.object({ kind: z.literal("COPY"), path, previousPath: path }).strict(),
  z.object({ kind: z.literal("CHMOD"), path, mode: z.enum(["100644", "100755"]) }).strict(),
]);
export const canonicalInputSchema = z.object({
  apiVersion: z.literal(2),
  parents: z.array(id).max(8).default([]),
  description: z.string().trim().min(1).max(2000),
  idempotencyKey: z.string().min(1).max(128).optional(),
  operations: z.array(operation).max(5000),
}).strict();
export type CanonicalInput = z.infer<typeof canonicalInputSchema>;
type Operation = CanonicalInput["operations"][number];
type Tx = Prisma.TransactionClient;
const limits = { maxObjectBytes: 4 * 1024 * 1024 };

function inputOrError(input: unknown): CanonicalInput {
  const parsed = canonicalInputSchema.safeParse(input);
  if (!parsed.success) throw new SourceControlError(422, "INVALID_INPUT", parsed.error.issues.map(x => x.message).join("; "));
  if (new Set(parsed.data.parents).size !== parsed.data.parents.length) {
    throw new SourceControlError(422, "DUPLICATE_PARENT", "Each parent must be unique");
  }
  return parsed.data;
}

function canonicalId(repositoryId: string, authorId: string, input: CanonicalInput) {
  // The retry key and server-assigned publication timestamp are not content identity.
  return digest(JSON.stringify([2, repositoryId, authorId, input.parents, input.description, input.operations]));
}

async function rootFor(tx: Tx, repositoryId: string, head: string | undefined, tree: SnapshotTree) {
  if (!head) return tree.empty();
  const existing = await publishedSnapshotRoot(tx, repositoryId, head);
  if (existing) {
    await tree.count(existing.rootId);
    return existing.rootId;
  }
  const legacy = await tx.sourceChangeset.findFirst({ where: { id: head, repositoryId },
    select: { treeId: true } });
  if (!legacy) throw new SourceControlError(422, "UNKNOWN_PARENT", "Parent not in repository");
  // A legacy v1 revision has a canonical full tree, so it needs no replay.
  if (legacy.treeId) return legacyRoot(tx, repositoryId, head, legacy.treeId, tree);
  throw new SourceControlError(409, "SNAPSHOT_NOT_MATERIALIZED",
    "Parent is missing an incremental checkpoint; use the resumable snapshot backfill");
}

export async function materializeCanonicalSnapshot(repositoryId: string, changesetId: string, actor: SourceActor) {
  return advanceSnapshotBuild(repositoryId, changesetId, actor);
}

async function legacySnapshotRead(tx: Tx, repositoryId: string, changesetId: string) {
  const change = await tx.sourceChangeset.findFirst({ where: { id: changesetId, repositoryId },
    select: { treeId: true } });
  if (!change?.treeId) {
    throw new SourceControlError(409, "SNAPSHOT_NOT_MATERIALIZED",
      "Incremental checkpoint missing; explicit resumable backfill required");
  }
  const object = await tx.sourceObject.findUnique({ where: { id: change.treeId } });
  if (!object?.data || object.kind !== "TREE") {
    throw new SourceControlError(409, "CORRUPT_HISTORY", "Missing legacy tree");
  }
  return decodeTree(object.data, change.treeId).map(e => ({
    path: e.path, objectId: e.objectId, mode: e.mode || "100644",
  }));
}

async function checkedBlob(tx: Tx, repositoryId: string, blobId: string, asSymlink = false): Promise<Uint8Array> {
  const access = await tx.sourceObjectGrant.findUnique({ where: {
    repositoryId_objectId: { repositoryId, objectId: blobId },
  } });
  if (!access) {
    const legacy = await tx.sourceFileOperation.findFirst({ where: {
      objectId: blobId, changeset: { repositoryId },
    }, select: { objectId: true } });
    if (!legacy) throw new SourceControlError(422, "OBJECT_UNAVAILABLE", "Object has not been staged in this repository");
  }
  const blob = await tx.sourceObject.findUnique({ where: { id: blobId } });
  if (!blob || blob.kind !== "BLOB") {
    throw new SourceControlError(409, "OBJECT_CORRUPT", "Missing immutable object");
  }
  if (blob.data) {
    if (blob.byteSize !== BigInt(blob.data.byteLength) || objectId("BLOB", blob.data) !== blobId) {
      throw new SourceControlError(409, "OBJECT_CORRUPT", "Damaged immutable blob");
    }
    return blob.data;
  }
  if (blob.externalId !== blobId) throw new SourceControlError(409, "OBJECT_CORRUPT", "Invalid external identity");
  // Lock against orphan GC until changeset publication completes.
  await tx.$queryRawUnsafe("SELECT id FROM \"StoredBlob\" WHERE id = $1 AND state = 'READY' FOR UPDATE", blobId);
  const stored = await tx.storedBlob.findFirst({ where: { id: blobId, state: "READY" } });
  if (!stored || stored.rawBytes !== blob.byteSize) {
    throw new SourceControlError(409, "OBJECT_UNAVAILABLE", "External object is not published");
  }
  if (!asSymlink) return new Uint8Array(0); // Verified at publication; avoid full-file reads in transactions.
  if (blob.byteSize > 4096n) throw new SourceControlError(422, "INVALID_SYMLINK", "Symlink target exceeds 4 KiB");
  const chunks: Buffer[] = [];
  for await (const part of await verifiedBlobStream(stored)) chunks.push(Buffer.from(part));
  return Buffer.concat(chunks);
}

function checkSymlink(path: string, bytes: Uint8Array) {
  if (bytes.byteLength > 4096) throw new SourceControlError(422, "INVALID_SYMLINK", "Symlink target exceeds 4 KiB");
  let target: string;
  try { target = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new SourceControlError(422, "INVALID_SYMLINK", "Symlink target must be UTF-8"); }
  const joined = posix.normalize(posix.join(posix.dirname(path), target));
  if (!target || target.includes("\0") || target.includes("\\") || posix.isAbsolute(target)
    || joined === ".." || joined.startsWith("../") || joined.startsWith("/")) {
    throw new SourceControlError(422, "INVALID_SYMLINK", "Symlink target escapes repository");
  }
}

export async function stageCanonicalBlob(repositoryId: string, actor: SourceActor, dataBase64: unknown) {
  if (typeof dataBase64 !== "string" || dataBase64.length > Math.ceil(limits.maxObjectBytes / 3) * 4 + 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(dataBase64)) {
    throw new SourceControlError(422, "INVALID_OBJECT", "Canonical base64 is required");
  }
  const data = Buffer.from(dataBase64, "base64");
  if (data.length > limits.maxObjectBytes || data.toString("base64") !== dataBase64) {
    throw new SourceControlError(413, "OBJECT_TOO_LARGE", "Object exceeds the 4 MiB JSON API limit");
  }
  const blobId = objectId("BLOB", data);
  await db.$transaction(async tx => {
    await assertRepositoryPermission(actor, repositoryId, "changeset:write", { allowStaging: true }, tx);
    const repo = await tx.repository.findUnique({ where: { id: repositoryId }, select: { id: true, maxStoredBytes: true } });
    if (!repo) throw new SourceControlError(404, "REPOSITORY_NOT_FOUND", "Unknown repository");
    await tx.sourceObject.createMany({ data: [{ id: blobId, kind: "BLOB", data, byteSize: data.length }], skipDuplicates: true });
    await checkedBlobAfterInsert(tx, blobId);
    const granted = await tx.sourceObjectGrant.createMany({ data: [{ repositoryId, objectId: blobId }], skipDuplicates: true });
    if (granted.count) {
      const reserved = await tx.repository.updateMany({ where: { id: repositoryId, storedBytes: { lte: repo!.maxStoredBytes - BigInt(data.length) } },
        data: { storedBytes: { increment: data.length } } });
      if (!reserved.count) throw new SourceControlError(429, "STORAGE_QUOTA", "Repository object storage quota exceeded");
    }
  });
  return { id: blobId, byteSize: data.length };
}

async function checkedBlobAfterInsert(tx: Tx, blobId: string) {
  const blob = await tx.sourceObject.findUnique({ where: { id: blobId } });
  if (!blob || blob.kind !== "BLOB") {
    throw new SourceControlError(409, "OBJECT_CORRUPT", "Stored object missing");
  }
  if (blob.data) {
    if (blob.byteSize !== BigInt(blob.data.byteLength) || objectId("BLOB", blob.data) !== blobId) {
      throw new SourceControlError(409, "OBJECT_CORRUPT", "Stored object failed integrity verification");
    }
  } else {
    if (blob.externalId !== blobId) throw new SourceControlError(409, "OBJECT_CORRUPT", "Invalid external object ID");
    await tx.$queryRawUnsafe("SELECT id FROM \"StoredBlob\" WHERE id = $1 AND state = 'READY' FOR UPDATE", blobId);
    const stored = await tx.storedBlob.findFirst({ where: { id: blobId, state: "READY" } });
    if (!stored || stored.rawBytes !== blob.byteSize) {
      throw new SourceControlError(409, "OBJECT_CORRUPT", "External blob is not ready");
    }
  }
}

export async function createCanonicalChangeset(repositoryId: string, actor: SourceActor, body: unknown, attempt = 0) {
  const input = inputOrError(body);
  const authorId = actor.type + ":" + actor.id;
  const changesetId = canonicalId(repositoryId, authorId, input);
  try {
    return await db.$transaction(async tx => {
      await assertRepositoryPermission(actor, repositoryId, "changeset:write", { paths: input.operations.flatMap(op =>
        "previousPath" in op ? [op.path, op.previousPath] : [op.path]) }, tx);
      const repository = await tx.repository.findUnique({ where: { id: repositoryId }, select: { id: true } });
      if (!repository) throw new SourceControlError(404, "REPOSITORY_NOT_FOUND", "Unknown repository");
      if (input.idempotencyKey) {
        const key = await tx.sourcePublicationKey.findUnique({ where: {
          repositoryId_authorId_key: { repositoryId, authorId, key: input.idempotencyKey },
        } });
        if (key) {
          if (key.changesetId !== changesetId) throw new SourceControlError(409, "IDEMPOTENCY_CONFLICT", "Key already used for a different changeset");
          return { id: changesetId, created: false };
        }
      }
      const existing = await tx.sourceChangeset.findUnique({ where: { id: changesetId }, select: { id: true, repositoryId: true } });
      if (existing && existing.repositoryId !== repositoryId) throw new SourceControlError(409, "IDENTITY_CONFLICT", "Content identity collision");
      if (!existing) {
        const parents = await tx.sourceChangeset.findMany({ where: { repositoryId, id: { in: input.parents } }, select: { id: true } });
        if (parents.length !== input.parents.length || input.parents.includes(changesetId)) {
          throw new SourceControlError(422, "UNKNOWN_PARENT", "All parents must be published and in the same repository");
        }
        const tree = new SnapshotTree(tx);
        let rootId = await rootFor(tx, repositoryId, input.parents[0], tree);
        const touched = new Set<string>();
        // Idempotent blob integrity/ownership checks are memoized for repeated
        // objects in large operation batches. Symlink targets require bytes.
        const blobProof = new Map<string, Uint8Array>();
        const verifyObject = async (objectRef: string, asSymlink: boolean) => {
          const cacheKey = objectRef + ":" + (asSymlink ? "link" : "blob");
          const cached = blobProof.get(cacheKey);
          if (cached) return cached;
          const verified = await checkedBlob(tx, repositoryId, objectRef, asSymlink);
          blobProof.set(cacheKey, verified);
          return verified;
        };
        const persisted = [];
        for (const [position, op] of input.operations.entries()) {
          if (touched.has(op.path)) throw new SourceControlError(422, "DUPLICATE_PATH", op.path);
          touched.add(op.path);
          if ((op.kind === "RENAME" || op.kind === "COPY") && op.previousPath === op.path) {
            throw new SourceControlError(422, "INVALID_RENAME", "Source and destination must differ");
          }
          const old = await tree.get(rootId, op.path);
          const source = "previousPath" in op ? await tree.get(rootId, op.previousPath) : undefined;
          const objectRef = "objectId" in op ? op.objectId : op.kind === "RENAME" || op.kind === "COPY" ? source?.objectId :
            op.kind === "CHMOD" ? old?.objectId : null;
          const requestedMode = "mode" in op ? op.mode : null;
          const original = "previousPath" in op ? op.previousPath : null;
          if (op.kind === "ADD" || op.kind === "MODIFY") {
            const isSymlink = (requestedMode || old?.mode) === "120000";
            const bytes = await verifyObject(objectRef!, isSymlink);
            if (isSymlink) checkSymlink(op.path, bytes);
          } else if ((op.kind === "COPY" || op.kind === "RENAME") && source?.mode === "120000") {
            const bytes = await verifyObject(source.objectId, true);
            checkSymlink(op.path, bytes);
          }
          if (op.kind === "ADD" || op.kind === "MODIFY") {
            if (op.kind === "ADD" && old) throw new SourceControlError(409, "DESTINATION_EXISTS", op.path);
            if (op.kind === "MODIFY" && !old) throw new SourceControlError(409, "MISSING_SOURCE", op.path);
            rootId = await tree.set(rootId, op.path, { objectId: objectRef!, mode:
              (requestedMode || old?.mode || "100644") as SnapshotEntry["mode"] });
          } else if (op.kind === "DELETE") {
            if (!old) throw new SourceControlError(409, "MISSING_SOURCE", op.path);
            rootId = await tree.set(rootId, op.path, null);
          } else if (op.kind === "RENAME" || op.kind === "COPY") {
            if (!source) throw new SourceControlError(409, "MISSING_SOURCE", op.previousPath);
            if (old) throw new SourceControlError(409, "DESTINATION_EXISTS", op.path);
            if (op.kind === "RENAME") rootId = await tree.set(rootId, op.previousPath, null);
            rootId = await tree.set(rootId, op.path, source);
          } else if (op.kind === "CHMOD") {
            if (!old || old.mode === "120000") throw new SourceControlError(409, "INVALID_MODE_CHANGE", op.path);
            if (old.mode === op.mode) throw new SourceControlError(409, "UNCHANGED_MODE", op.path);
            rootId = await tree.set(rootId, op.path, { ...old, mode: op.mode });
          }
          persisted.push({ kind: op.kind, path: op.path, previousPath: original, objectId: objectRef,
            fileMode: requestedMode, position });
        }
        // Match v2 delta semantics: operations are ordered, but the path graph
        // must be valid in the final state, not at every intermediate step.
        // Validate only affected live files; no full-tree enumeration occurs.
        const graphChecks = new Set(input.operations.flatMap(op =>
          "previousPath" in op ? [op.path, op.previousPath] : [op.path]));
        for (const checkedPath of graphChecks) {
          if (await tree.get(rootId, checkedPath)) await tree.checkSlot(rootId, checkedPath);
        }
        const snapshotStats = await tree.persist(rootId);
        const meta = deriveChangesetMetadata(persisted.map(op => ({
          kind: op.kind as "PUT", path: op.path, previousPath: op.previousPath ?? undefined,
          objectId: op.objectId ?? undefined,
        })));
        await tx.sourceChangeset.create({ data: {
          id: changesetId, repositoryId, treeId: null, authorId, message: input.description,
          parents: { create: input.parents.map((parentId, position) => ({ parentId, position })) },
          validation: { create: { state: "SUCCESS", ...meta } },
          review: { create: { repositoryId } },
        } });
        // Persist large operation sets in bounded SQL statements, preserving
        // the ordered canonical identity and transactional atomicity.
        for (let offset = 0; offset < persisted.length; offset += 250) {
          await tx.sourceFileOperation.createMany({ data: persisted.slice(offset, offset + 250).map(p => ({
            changesetId, kind: p.kind, path: p.path, previousPath: p.previousPath,
            objectId: p.objectId, position: p.position, fileMode: p.fileMode,
          })) });
        }
        await tx.sourceSnapshotRoot.create({ data: { repositoryId, changesetId, rootId } });
        await tx.sourceQueryIndexJob.create({ data: { repositoryId, changesetId } });
        await tx.sourceChangesetEvent.create({ data: {
          repositoryId, changesetId, kind: "changeset.published",
          payload: { apiVersion: 2, changesetId, parents: input.parents, authorId, operationCount: persisted.length },
        } });
        await tx.auditEvent.create({ data: {
          repositoryId, actorType: actor.type, actorId: actor.id, action: "changeset.published", subjectId: changesetId,
          metadata: { apiVersion: 2, operationCount: persisted.length, snapshotStats },
        } });
      }
      if (input.idempotencyKey) await tx.sourcePublicationKey.create({ data: {
        repositoryId, authorId, key: input.idempotencyKey, changesetId,
      } });
      return { id: changesetId, created: !existing };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 120000, maxWait: 15000 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002" && attempt < 3) {
      return createCanonicalChangeset(repositoryId, actor, body, attempt + 1);
    }
    throw error;
  }
}

export async function getCanonicalChangeset(repositoryId: string, changesetId: string, actor?: SourceActor) {
  if (!actor) throw new SourceControlError(401, "UNAUTHORIZED", "Authentication required");
  await assertRepositoryPermission(actor, repositoryId, "source:read");
  const record = await db.sourceChangeset.findFirst({ where: { repositoryId, id: changesetId },
    include: { parents: { orderBy: { position: "asc" } }, operations: { orderBy: { position: "asc" } }, validation: true } });
  if (!record) throw new SourceControlError(404, "NOT_FOUND", "Changeset not found");
  return record;
}

export async function listCanonicalChangesets(repositoryId: string, limit = 30, actor?: SourceActor) {
  if (!actor) throw new SourceControlError(401, "UNAUTHORIZED", "Authentication required");
  await assertRepositoryPermission(actor, repositoryId, "source:read");
  return db.sourceChangeset.findMany({ where: { repositoryId },
    take: Math.min(100, Math.max(1, limit)), orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    include: { parents: { orderBy: { position: "asc" } },
      operations: { orderBy: { position: "asc" } } } });
}

/** Opt-in backward-compatible keyset pagination on the immutable path index. */
export async function getCanonicalSnapshotPage(
  repositoryId: string, changesetId: string, actor: SourceActor,
  size = 200, cursor = "", directory = "",
) {
  await assertRepositoryPermission(actor, repositoryId, "source:read");
  return db.$transaction(async tx => {
    const change = await tx.sourceChangeset.findFirst({ where: { repositoryId, id: changesetId },
      select: { treeId: true } });
    if (!change) throw new SourceControlError(404, "NOT_FOUND", "Changeset not found");
    const root = await publishedSnapshotRoot(tx, repositoryId, changesetId);
    if (root) {
      const tree = new SnapshotTree(tx);
      return { changesetId, treeId: change.treeId,
        ...await tree.page(root.rootId, size, cursor, directory) };
    }
    const entries = await legacySnapshotRead(tx, repositoryId, changesetId);
    if (!Number.isSafeInteger(size) || size < 1 || size > 1000 ||
        (cursor && !validPath(cursor)) || (directory && !validPath(directory))) {
      throw new SourceControlError(422, "INVALID_PAGE", "Invalid snapshot cursor or limit");
    }
    const prefix = directory ? directory + "/" : "";
    const page = entries.filter(e => e.path.startsWith(prefix) &&
      Buffer.compare(Buffer.from(e.path), Buffer.from(cursor)) > 0)
      .sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))).slice(0, size + 1);
    return { changesetId, treeId: change.treeId, entries: page.slice(0, size),
      nextCursor: page.length > size ? page[size - 1].path : null };
  }, { timeout: 30000 });
}

export async function getCanonicalSnapshot(repositoryId: string, changesetId: string, actor?: SourceActor) {
  if (!actor) throw new SourceControlError(401, "UNAUTHORIZED", "Authentication required");
  const change = await getCanonicalChangeset(repositoryId, changesetId, actor);
  return db.$transaction(async tx => {
    const root = await publishedSnapshotRoot(tx, repositoryId, changesetId);
    if (root) {
      const tree = new SnapshotTree(tx);
      return { changesetId, treeId: change.treeId, entries: await tree.entries(root.rootId) };
    }
    return { changesetId, treeId: change.treeId,
      entries: await legacySnapshotRead(tx, repositoryId, changesetId) };
  }, { timeout: 120000 });
}

// Internal review-worker access is tied to an active, exact changeset review lease.
// It never changes the authentication requirement of externally reachable read APIs.
export async function getCanonicalSnapshotForReview(
  repositoryId: string, changesetId: string, reviewedChangesetId: string, lease: Date,
) {
  const review = await db.sourceReview.findFirst({ where: {
    repositoryId, changesetId: reviewedChangesetId, state: "RUNNING", leaseUntil: lease,
  }, select: { changesetId: true } });
  if (!review) throw new SourceControlError(403, "REVIEW_LEASE_REQUIRED", "An active review lease is required");
  const reviewed = await db.sourceChangeset.findFirst({ where: {
    id: reviewedChangesetId, repositoryId,
  }, select: { parents: { where: { position: 0 }, select: { parentId: true } } } });
  if (!reviewed || (changesetId !== reviewedChangesetId && changesetId !== reviewed.parents[0]?.parentId)) {
    throw new SourceControlError(403, "REVIEW_SCOPE_DENIED", "Review may only inspect its changeset and first parent");
  }
  const change = await db.sourceChangeset.findFirst({ where: { repositoryId, id: changesetId },
    select: { treeId: true } });
  if (!change) throw new SourceControlError(404, "NOT_FOUND", "Changeset not found");
  return db.$transaction(async tx => {
    const root = await publishedSnapshotRoot(tx, repositoryId, changesetId);
    if (root) {
      const tree = new SnapshotTree(tx);
      return { changesetId, treeId: change.treeId, entries: await tree.entries(root.rootId) };
    }
    return { changesetId, treeId: change.treeId,
      entries: await legacySnapshotRead(tx, repositoryId, changesetId) };
  }, { timeout: 120000 });
}

// Trusted validation workers consume immutable revisions after their calling service
// has authorized admission. Public source-control APIs still require an actor.
export async function readCanonicalSnapshotForValidation(repositoryId: string, changesetId: string) {
  const change = await db.sourceChangeset.findFirst({ where: { repositoryId, id: changesetId },
    select: { treeId: true } });
  if (!change) throw new SourceControlError(404, "NOT_FOUND", "Validation revision not found");
  return db.$transaction(async tx => {
    const root = await publishedSnapshotRoot(tx, repositoryId, changesetId);
    if (root) {
      const tree = new SnapshotTree(tx);
      return { changesetId, treeId: change.treeId, entries: await tree.entries(root.rootId) };
    }
    return { changesetId, treeId: change.treeId,
      entries: await legacySnapshotRead(tx, repositoryId, changesetId) };
  }, { timeout: 120000 });
}

export async function listCanonicalEvents(repositoryId: string, limit = 30, actor?: SourceActor) {
  if (!actor) throw new SourceControlError(401, "UNAUTHORIZED", "Authentication required");
  await assertRepositoryPermission(actor, repositoryId, "source:read");
  return db.sourceChangesetEvent.findMany({ where: { repositoryId },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: Math.min(100, Math.max(1, limit)) });
}

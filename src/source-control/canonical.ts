import { createHash } from "node:crypto";
import { posix } from "node:path";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "../lib/prisma";
import { validPath } from "../lib/review-logic";
import { SourceControlError, type SourceActor } from "./contracts";
import { decodeTree, objectId } from "./storage";
import { deriveChangesetMetadata } from "./derived";

const digest = (data: string) => createHash("sha256").update(data).digest("hex");
const id = z.string().regex(/^[a-f0-9]{64}$/);
const path = z.string().max(512).refine(validPath, "Invalid relative path");
const mode = z.enum(["100644", "100755", "120000"]);
const operation = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ADD"), path, objectId: id, mode: mode.default("100644") }).strict(),
  z.object({ kind: z.literal("MODIFY"), path, objectId: id }).strict(),
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
  operations: z.array(operation).max(200),
}).strict();
export type CanonicalInput = z.infer<typeof canonicalInputSchema>;
type Operation = CanonicalInput["operations"][number];
type Entry = { objectId: string; mode: "100644" | "100755" | "120000" };
type State = Map<string, Entry>;
type Tx = Prisma.TransactionClient;
const limits = { maxDepth: 1024, maxPaths: 10000, maxObjectBytes: 4 * 1024 * 1024 };

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

function validState(state: State) {
  if (state.size > limits.maxPaths) throw new SourceControlError(413, "TOO_MANY_PATHS", "Repository snapshot exceeds 10,000 paths");
  for (const path of state.keys()) {
    if (!validPath(path)) throw new SourceControlError(422, "INVALID_PATH_GRAPH", "Invalid stored path");
    const parts = path.split("/");
    for (let n = 1; n < parts.length; n++) {
      if (state.has(parts.slice(0, n).join("/"))) {
        throw new SourceControlError(422, "INVALID_PATH_GRAPH", "A file cannot contain other files");
      }
    }
  }
}

function apply(state: State, op: { kind: string; path: string; previousPath?: string | null; objectId?: string | null; fileMode?: string | null }) {
  const old = state.get(op.path);
  if (op.kind === "ADD") {
    if (old) throw new SourceControlError(409, "DESTINATION_EXISTS", op.path);
    state.set(op.path, { objectId: op.objectId!, mode: (op.fileMode || "100644") as Entry["mode"] });
  } else if (op.kind === "MODIFY" || op.kind === "PUT") {
    if (op.kind === "MODIFY" && !old) throw new SourceControlError(409, "MISSING_SOURCE", op.path);
    state.set(op.path, { objectId: op.objectId!, mode: old?.mode || "100644" });
  } else if (op.kind === "DELETE") {
    if (!old) throw new SourceControlError(409, "MISSING_SOURCE", op.path);
    state.delete(op.path);
  } else if (op.kind === "RENAME" || op.kind === "MOVE" || op.kind === "COPY") {
    const from = state.get(op.previousPath!);
    if (!from) throw new SourceControlError(409, "MISSING_SOURCE", op.previousPath!);
    if (old || op.previousPath === op.path) throw new SourceControlError(409, "DESTINATION_EXISTS", op.path);
    if (op.kind !== "COPY") state.delete(op.previousPath!);
    state.set(op.path, { ...from });
  } else if (op.kind === "CHMOD") {
    if (!old || old.mode === "120000") throw new SourceControlError(409, "INVALID_MODE_CHANGE", op.path);
    if (old.mode === op.fileMode) throw new SourceControlError(409, "UNCHANGED_MODE", op.path);
    state.set(op.path, { ...old, mode: op.fileMode as Entry["mode"] });
  } else {
    throw new SourceControlError(422, "INVALID_OPERATION", "Unrecognized operation");
  }
}

async function snapshot(tx: Tx, repositoryId: string, head: string | undefined): Promise<State> {
  const chain: Array<{ operations: Array<{ kind: string; path: string; previousPath: string | null; objectId: string | null; fileMode: string | null }> }> = [];
  const seen = new Set<string>();
  let cursor = head;
  let state: State = new Map();
  while (cursor) {
    if (seen.has(cursor) || seen.size >= limits.maxDepth) {
      throw new SourceControlError(422, "INVALID_GRAPH", "Cyclic or excessively deep first-parent history");
    }
    seen.add(cursor);
    const change = await tx.sourceChangeset.findFirst({ where: { repositoryId, id: cursor },
      select: { id: true, treeId: true, parents: { where: { position: 0 }, select: { parentId: true } },
        operations: { orderBy: { position: "asc" }, select: {
          kind: true, path: true, previousPath: true, objectId: true, fileMode: true,
        } } } });
    if (!change) throw new SourceControlError(422, "UNKNOWN_PARENT", "Parent does not belong to the repository");
    if (change.treeId) {
      const tree = await tx.sourceObject.findUnique({ where: { id: change.treeId } });
      if (!tree || tree.kind !== "TREE") throw new SourceControlError(409, "CORRUPT_HISTORY", "Missing legacy tree");
      state = new Map(decodeTree(tree.data, tree.id).map(x => [x.path, { objectId: x.objectId, mode: "100644" as const }]));
      break;
    }
    chain.push(change);
    cursor = change.parents[0]?.parentId;
  }
  for (const change of chain.reverse()) {
    for (const op of change.operations) apply(state, op);
    validState(state);
  }
  return state;
}

async function checkedBlob(tx: Tx, repositoryId: string, blobId: string) {
  const access = await tx.sourceObjectGrant.findUnique({ where: {
    repositoryId_objectId: { repositoryId, objectId: blobId },
  } });
  if (!access) {
    // Objects committed before v2 remain usable by the owning repository.
    const legacy = await tx.sourceFileOperation.findFirst({ where: { objectId: blobId, changeset: { repositoryId } },
      select: { objectId: true } });
    if (!legacy) throw new SourceControlError(422, "OBJECT_UNAVAILABLE", "Object has not been staged in this repository");
  }
  const blob = await tx.sourceObject.findUnique({ where: { id: blobId } });
  if (!blob || blob.kind !== "BLOB" || blob.byteSize !== blob.data.byteLength || objectId("BLOB", blob.data) !== blobId) {
    throw new SourceControlError(409, "OBJECT_CORRUPT", "Missing or damaged immutable blob");
  }
  return blob.data;
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

export async function stageCanonicalBlob(repositoryId: string, dataBase64: unknown) {
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
    const repo = await tx.repository.findUnique({ where: { id: repositoryId }, select: { id: true } });
    if (!repo) throw new SourceControlError(404, "REPOSITORY_NOT_FOUND", "Unknown repository");
    await tx.sourceObject.createMany({ data: [{ id: blobId, kind: "BLOB", data, byteSize: data.length }], skipDuplicates: true });
    await checkedBlobAfterInsert(tx, blobId);
    await tx.sourceObjectGrant.createMany({ data: [{ repositoryId, objectId: blobId }], skipDuplicates: true });
  });
  return { id: blobId, byteSize: data.length };
}

async function checkedBlobAfterInsert(tx: Tx, blobId: string) {
  const blob = await tx.sourceObject.findUnique({ where: { id: blobId } });
  if (!blob || blob.kind !== "BLOB" || blob.byteSize !== blob.data.byteLength || objectId("BLOB", blob.data) !== blobId) {
    throw new SourceControlError(409, "OBJECT_CORRUPT", "Stored object failed integrity verification");
  }
}

export async function createCanonicalChangeset(repositoryId: string, actor: SourceActor, body: unknown, attempt = 0) {
  const input = inputOrError(body);
  const authorId = actor.type + ":" + actor.id;
  const changesetId = canonicalId(repositoryId, authorId, input);
  try {
    return await db.$transaction(async tx => {
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
        const state = await snapshot(tx, repositoryId, input.parents[0]);
        const touched = new Set<string>();
        const persisted = [];
        for (const [position, op] of input.operations.entries()) {
          if (touched.has(op.path)) throw new SourceControlError(422, "DUPLICATE_PATH", op.path);
          touched.add(op.path);
          if ((op.kind === "RENAME" || op.kind === "COPY") && op.previousPath === op.path) {
            throw new SourceControlError(422, "INVALID_RENAME", "Source and destination must differ");
          }
          const old = state.get(op.path);
          const source = "previousPath" in op ? state.get(op.previousPath) : undefined;
          const objectRef = "objectId" in op ? op.objectId : op.kind === "RENAME" || op.kind === "COPY" ? source?.objectId :
            op.kind === "CHMOD" ? old?.objectId : null;
          const requestedMode = "mode" in op ? op.mode : null;
          const original = "previousPath" in op ? op.previousPath : null;
          // File modes and referenced contents are validated before any changeset row is inserted.
          if (op.kind === "ADD" || op.kind === "MODIFY") {
            const bytes = await checkedBlob(tx, repositoryId, objectRef!);
            if ((op.kind === "ADD" ? requestedMode : old?.mode) === "120000") checkSymlink(op.path, bytes);
          } else if (op.kind === "COPY" || op.kind === "RENAME") {
            if (source?.mode === "120000") {
              const bytes = await checkedBlob(tx, repositoryId, source.objectId);
              checkSymlink(op.path, bytes);
            }
          }
          const record = { kind: op.kind, path: op.path, previousPath: original, objectId: objectRef,
            fileMode: requestedMode, position };
          apply(state, record);
          persisted.push(record);
        }
        validState(state);
        const meta = deriveChangesetMetadata(persisted.map(op => ({
          kind: op.kind as "PUT", path: op.path, previousPath: op.previousPath ?? undefined,
          objectId: op.objectId ?? undefined,
        })));
        await tx.sourceChangeset.create({ data: {
          id: changesetId, repositoryId, treeId: null, authorId, message: input.description,
          parents: { create: input.parents.map((parentId, position) => ({ parentId, position })) },
          operations: { create: persisted.map(p => ({
            kind: p.kind, path: p.path, previousPath: p.previousPath, objectId: p.objectId,
            position: p.position, fileMode: p.fileMode,
          })) },
          validation: { create: { state: "SUCCESS", ...meta } },
        } });
        await tx.sourceQueryIndexJob.create({ data: { repositoryId, changesetId } });
        await tx.sourceChangesetEvent.create({ data: {
          repositoryId, changesetId, kind: "changeset.published",
          payload: { apiVersion: 2, changesetId, parents: input.parents, authorId, operationCount: persisted.length },
        } });
        await tx.auditEvent.create({ data: {
          repositoryId, actorType: actor.type, actorId: actor.id, action: "changeset.published", subjectId: changesetId,
          metadata: { apiVersion: 2, operationCount: persisted.length },
        } });
      }
      if (input.idempotencyKey) await tx.sourcePublicationKey.create({ data: {
        repositoryId, authorId, key: input.idempotencyKey, changesetId,
      } });
      return { id: changesetId, created: !existing };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 20000, maxWait: 15000 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002" && attempt < 3) {
      return createCanonicalChangeset(repositoryId, actor, body, attempt + 1);
    }
    throw error;
  }
}

export async function getCanonicalChangeset(repositoryId: string, changesetId: string) {
  const record = await db.sourceChangeset.findFirst({ where: { repositoryId, id: changesetId },
    include: { parents: { orderBy: { position: "asc" } }, operations: { orderBy: { position: "asc" } }, validation: true } });
  if (!record) throw new SourceControlError(404, "NOT_FOUND", "Changeset not found");
  return record;
}

export async function listCanonicalChangesets(repositoryId: string, limit = 30) {
  return db.sourceChangeset.findMany({ where: { repositoryId },
    take: Math.min(100, Math.max(1, limit)), orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    include: { parents: { orderBy: { position: "asc" } },
      operations: { orderBy: { position: "asc" } } } });
}

export async function getCanonicalSnapshot(repositoryId: string, changesetId: string) {
  const change = await getCanonicalChangeset(repositoryId, changesetId);
  const state = await db.$transaction(tx => snapshot(tx, repositoryId, changesetId), { timeout: 20000 });
  return { changesetId, treeId: change.treeId, entries: [...state.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([path, entry]) => ({ path, ...entry })) };
}

export async function listCanonicalEvents(repositoryId: string, limit = 30) {
  return db.sourceChangesetEvent.findMany({ where: { repositoryId },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: Math.min(100, Math.max(1, limit)) });
}

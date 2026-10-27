import { createHash } from "node:crypto";
import { db } from "../lib/prisma";
import { stageCanonicalBlob } from "./canonical";
import { SourceControlError, type SourceActor } from "./contracts";
import { objectId } from "./storage";
const valid = /^[a-f0-9]{64}$/;
const limit = 4 * 1024 * 1024;
export async function startUpload(repo: string, id: string, size: number, actor: SourceActor) {
  if (!valid.test(id) || !Number.isSafeInteger(size) || size < 0 || size > limit)
    throw new SourceControlError(422, "INVALID_UPLOAD", "Invalid object identity or size (max 4 MiB)");
  const grant = await db.sourceObjectGrant.findUnique({ where: { repositoryId_objectId: { repositoryId: repo, objectId: id } } });
  if (grant) return { id, received: size, complete: true, chunkSize: 262144 };
  let session = await db.sourceObjectUpload.findUnique({ where: { repositoryId_objectId: { repositoryId: repo, objectId: id } } });
  if (session && session.byteSize !== size) throw new SourceControlError(409, "UPLOAD_SIZE_MISMATCH", "Upload size differs");
  if (!session) {
    session = await db.sourceObjectUpload.upsert({
      where: { repositoryId_objectId: { repositoryId: repo, objectId: id } },
      create: { repositoryId: repo, objectId: id, byteSize: size, received: 0, data: Buffer.alloc(0) },
      update: {},
    });
  }
  if (session.received === size) {
    await finalize(repo, id, session.data, actor);
    return { id, received: size, complete: true, chunkSize: 262144 };
  }
  return { id, received: session.received, complete: false, chunkSize: 262144 };
}
async function finalize(repo: string, id: string, bytes: Uint8Array, actor: SourceActor) {
  if (objectId("BLOB", bytes) !== id) {
    await db.sourceObjectUpload.deleteMany({ where: { repositoryId: repo, objectId: id } });
    throw new SourceControlError(409, "CHECKSUM_MISMATCH", "Upload checksum mismatch; restart the upload");
  }
  await stageCanonicalBlob(repo, actor, Buffer.from(bytes).toString("base64"));
  await db.sourceObjectUpload.deleteMany({ where: { repositoryId: repo, objectId: id } });
}
export async function appendUpload(repo: string, id: string, offset: number, bytes: Buffer, actor: SourceActor) {
  if (!valid.test(id) || !Number.isSafeInteger(offset) || offset < 0 || bytes.length === 0 || bytes.length > 262144)
    throw new SourceControlError(422, "INVALID_CHUNK", "Invalid upload chunk or offset");
  const session = await db.$transaction(async tx => {
    const current = await tx.sourceObjectUpload.findUnique({ where: { repositoryId_objectId: { repositoryId: repo, objectId: id } } });
    if (!current) throw new SourceControlError(404, "UPLOAD_NOT_FOUND", "Start an upload session first");
    if (offset !== current.received) throw new SourceControlError(409, "UPLOAD_OFFSET_CONFLICT", `Expected offset ${current.received}`);
    if (current.received + bytes.length > current.byteSize) throw new SourceControlError(413, "UPLOAD_TOO_LARGE", "Upload exceeds declared size");
    const combined = Buffer.concat([current.data, bytes]);
    const updated = await tx.sourceObjectUpload.updateMany({ where: { repositoryId: repo, objectId: id, received: offset },
      data: { received: offset + bytes.length, data: combined } });
    if (updated.count !== 1) throw new SourceControlError(409, "UPLOAD_OFFSET_CONFLICT", "Concurrent upload: refresh offset");
    return { received: offset + bytes.length, byteSize: current.byteSize, data: combined };
  });
  if (session.received === session.byteSize) {
    await finalize(repo, id, session.data, actor);
    return { id, received: session.received, complete: true };
  }
  return { id, received: session.received, complete: false };
}

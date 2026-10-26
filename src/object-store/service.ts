import { createHash, randomUUID } from "node:crypto";
import { Readable, PassThrough, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip, createGunzip } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";
import { db } from "../lib/prisma";
import { objectKey, s3, ObjectStorageError, type ObjectBackend, type StoredPart } from "./s3";

export const PART_BYTES = 16 * 1024 * 1024;
export const MAX_OBJECT_BYTES = 100 * 1024 * 1024 * 1024;
const RETENTION_MS = 24 * 60 * 60 * 1000;
const PUBLISH_LEASE_MS = 2 * 60 * 1000;
const ID = /^[a-f0-9]{64}$/;
type BlobRecord = {
  id: string; objectKey: string; encoding: string; rawSha256: string;
  rawBytes: bigint; storedBytes: bigint;
};
const metric = (event: string, info: Record<string, string | number> = {}) =>
  console.info(JSON.stringify({ event: "object_storage." + event, ...info, at: new Date().toISOString() }));
const later = (ms: number) => new Date(Date.now() + ms);
const blobDigest = () => createHash("sha256").update("BLOB\0");

export async function verifiedBlobStream(record: BlobRecord, backend: ObjectBackend = s3(),
  key = record.objectKey): Promise<Readable> {
  if (record.encoding !== "gzip") throw new ObjectStorageError("Unsupported object encoding", 500);
  const response = await backend.get(key);
  const output = new PassThrough({ highWaterMark: 64 * 1024 });
  const digest = blobDigest();
  const rawHash = createHash("sha256");
  let expanded = 0;
  let stored = 0;
  const compressedCheck = new Transform({
    transform(chunk: Buffer, _enc, next) {
      stored += chunk.length;
      next(stored > Number(record.storedBytes)
        ? new ObjectStorageError("Stored length exceeded", 422) : null, chunk);
    },
  });
  const rawCheck = new Transform({
    transform(chunk: Buffer, _enc, next) {
      expanded += chunk.length;
      if (expanded > Number(record.rawBytes) || expanded > MAX_OBJECT_BYTES ||
          expanded > Math.max(2 * 1024 * 1024, stored * 8192)) {
        next(new ObjectStorageError("Decompression safety limit exceeded", 422));
        return;
      }
      digest.update(chunk);
      rawHash.update(chunk);
      next(null, chunk);
    },
    flush(next) {
      if (stored !== Number(record.storedBytes) || expanded !== Number(record.rawBytes) ||
          digest.digest("hex") !== record.id || rawHash.digest("hex") !== record.rawSha256) {
        next(new ObjectStorageError("Stored content failed SHA-256 verification", 422));
        return;
      }
      next();
    },
  });
  void pipeline(response, compressedCheck, createGunzip(), rawCheck, output).catch(error => {
    metric("integrity_failure", { prefix: record.id.slice(0, 12) });
    output.destroy(error);
  });
  return output;
}

export async function verifyBlob(record: BlobRecord, backend: ObjectBackend = s3(),
  key = record.objectKey) {
  for await (const _chunk of await verifiedBlobStream(record, backend, key)) { /* bounded consumption */ }
}

async function retain(repositoryId: string, objectId: string) {
  await db.$transaction(async tx => {
    await tx.$queryRawUnsafe(
      "SELECT id FROM \"StoredBlob\" WHERE id = $1 AND state = 'READY' FOR UPDATE", objectId);
    const ready = await tx.storedBlob.findFirst({ where: { id: objectId, state: "READY" } });
    if (!ready) throw new ObjectStorageError("Object not published", 409);
    await tx.sourceObject.createMany({ data: [{
      id: objectId, kind: "BLOB", data: null, externalId: objectId, byteSize: ready.rawBytes,
    }], skipDuplicates: true });
    await tx.sourceObjectGrant.createMany({ data: [{ repositoryId, objectId }], skipDuplicates: true });
    await tx.blobLease.upsert({
      where: { repositoryId_objectId: { repositoryId, objectId } },
      create: { repositoryId, objectId, expiresAt: later(RETENTION_MS) },
      update: { expiresAt: later(RETENTION_MS) },
    });
  });
}

export async function uploadBlob(repositoryId: string, readable: Readable,
  expectedHash?: string | null, backend: ObjectBackend = s3()) {
  if (expectedHash && !ID.test(expectedHash)) throw new ObjectStorageError("Invalid expected SHA-256", 422);
  const transferId = randomUUID();
  const stagingKey = "staging/" + repositoryId + "/" + transferId;
  await db.blobTransfer.create({ data: { id: transferId, repositoryId, stagingKey } });
  let multipartId: string | undefined;
  let complete = false;
  let compressed: ReturnType<typeof createGzip> | undefined;
  const started = Date.now();
  try {
    multipartId = await backend.initiate(stagingKey);
    await db.blobTransfer.update({ where: { id: transferId }, data: { uploadId: multipartId } });
    let rawBytes = 0;
    let storedBytes = 0;
    const digest = blobDigest();
    const rawHash = createHash("sha256");
    const hashInput = new Transform({
      transform(chunk: Buffer, _enc, next) {
        rawBytes += chunk.length;
        if (rawBytes > MAX_OBJECT_BYTES) return next(new ObjectStorageError("File too large", 413));
        digest.update(chunk); rawHash.update(chunk); next(null, chunk);
      },
    });
    const gzip = createGzip({ level: 6 });
    compressed = gzip;
    readable.pipe(hashInput).pipe(gzip);
    readable.on("error", error => hashInput.destroy(error));
    hashInput.on("error", error => gzip.destroy(error));
    const parts: StoredPart[] = [];
    const fragments: Buffer[] = [];
    let buffered = 0;
    const flush = async () => {
      if (!buffered) return;
      if (parts.length >= 10000) throw new ObjectStorageError("Multipart limit exceeded", 413);
      const bytes = Buffer.concat(fragments, buffered);
      fragments.length = 0;
      buffered = 0;
      parts.push(await backend.part(stagingKey, multipartId!, parts.length + 1, bytes));
      // Refresh durable transfer timestamp to prevent cleanup of an active large upload.
      await db.blobTransfer.update({ where: { id: transferId }, data: { updatedAt: new Date() } });
    };
    for await (const encoded of gzip) {
      const chunk = Buffer.from(encoded);
      storedBytes += chunk.length;
      if (storedBytes > MAX_OBJECT_BYTES) throw new ObjectStorageError("Encoded size limit exceeded", 413);
      for (let start = 0; start < chunk.length;) {
        const amount = Math.min(PART_BYTES - buffered, chunk.length - start);
        fragments.push(chunk.subarray(start, start + amount));
        buffered += amount; start += amount;
        if (buffered === PART_BYTES) await flush();
      }
    }
    await flush();
    if (!parts.length) throw new ObjectStorageError("Compression produced no parts", 502);
    await backend.complete(stagingKey, multipartId, parts);
    complete = true;
    await db.blobTransfer.update({ where: { id: transferId }, data: { state: "STAGED" } });
    const objectId = digest.digest("hex");
    if (expectedHash && expectedHash !== objectId) throw new ObjectStorageError("Upload SHA-256 mismatch", 422);
    const record = { id: objectId, objectKey: objectKey(objectId), encoding: "gzip",
      rawSha256: rawHash.digest("hex"), rawBytes: BigInt(rawBytes), storedBytes: BigInt(storedBytes) };
    await verifyBlob(record, backend, stagingKey);
    const deduplicated = await publishBlob(record, transferId, stagingKey, backend);
    await retain(repositoryId, objectId);
    await db.blobTransfer.update({ where: { id: transferId }, data: { state: "FINISHED" } });
    metric("uploaded", { rawBytes, storedBytes, deduplicated: String(deduplicated), latencyMs: Date.now() - started });
    return { id: objectId, rawBytes: String(rawBytes), storedBytes: String(storedBytes), deduplicated };
  } catch (error) {
    readable.destroy();
    compressed?.destroy();
    metric("upload_failed", { latencyMs: Date.now() - started });
    if (!complete && multipartId) await backend.abort(stagingKey, multipartId).catch(() => {});
    await db.blobTransfer.update({ where: { id: transferId }, data: { state: "FAILED" } }).catch(() => {});
    throw error;
  }
}

async function publishBlob(record: BlobRecord, owner: string, stagingKey: string, backend: ObjectBackend) {
  await db.storedBlob.createMany({ data: [{ ...record, state: "PUBLISHING",
    stagingKey, publisherId: owner, publishLeaseUntil: later(PUBLISH_LEASE_MS),
    retainUntil: later(RETENTION_MS) }], skipDuplicates: true });
  for (let attempt = 0; attempt < 120; attempt++) {
    const found = await db.storedBlob.findUniqueOrThrow({ where: { id: record.id } });
    if (found.state === "READY") {
      if (found.rawBytes !== record.rawBytes || found.rawSha256 !== record.rawSha256)
        throw new ObjectStorageError("SHA-256 identity collision", 500);
      // A duplicate must never silently accept bytes corrupted after publication.
      await verifyBlob(found, backend);
      return true;
    }
    if (found.state === "DELETING") throw new ObjectStorageError("Object is being deleted; retry", 409);
    if (found.publisherId === owner) {
      // Keep long S3 copy + verify operations leased while the request is still alive.
      const heartbeat = setInterval(() => {
        void db.storedBlob.updateMany({ where: { id: record.id, state: "PUBLISHING", publisherId: owner },
          data: { publishLeaseUntil: later(PUBLISH_LEASE_MS) } }).catch(error =>
          console.error("Object publication heartbeat failed", { id: record.id, error }));
      }, 30000);
      heartbeat.unref();
      try {
        const bytes = await backend.head(record.objectKey);
        if (bytes !== Number(record.storedBytes))
          await backend.copy(stagingKey, record.objectKey, Number(record.storedBytes));
        await verifyBlob(record, backend);
        const result = await db.storedBlob.updateMany({ where: {
          id: record.id, state: "PUBLISHING", publisherId: owner },
          data: { state: "READY", stagingKey: null, verifiedAt: new Date(), publishLeaseUntil: null } });
        if (result.count !== 1) throw new ObjectStorageError("Publication lease lost", 409);
        return false;
      } finally {
        clearInterval(heartbeat);
      }
    }
    if (found.publishLeaseUntil && found.publishLeaseUntil < new Date()) {
      await db.storedBlob.updateMany({ where: { id: record.id, state: "PUBLISHING",
        publishLeaseUntil: { lt: new Date() } },
        data: { publisherId: owner, stagingKey, publishLeaseUntil: later(PUBLISH_LEASE_MS) } });
    }
    await delay(250);
  }
  throw new ObjectStorageError("Object publication in progress", 409);
}

export async function findReadableObject(repositoryId: string, id: string) {
  if (!ID.test(id)) throw new ObjectStorageError("Invalid object ID", 404);
  const record = await db.storedBlob.findFirst({ where: { id, state: "READY" } });
  if (!record) throw new ObjectStorageError("Object not found", 404);
  const [lease, operation] = await Promise.all([
    db.blobLease.findFirst({ where: { repositoryId, objectId: id, expiresAt: { gt: new Date() } } }),
    db.sourceFileOperation.findFirst({ where: { objectId: id, changeset: { repositoryId } } }),
  ]);
  if (!lease && !operation) throw new ObjectStorageError("Object not found", 404);
  return record;
}

export async function recoverPublications(backend: ObjectBackend = s3(), limit = 20) {
  const expired = await db.storedBlob.findMany({
    where: { state: "PUBLISHING", publishLeaseUntil: { lt: new Date() } }, take: limit });
  let recovered = 0;
  for (const record of expired) {
    const owner = randomUUID();
    const claim = await db.storedBlob.updateMany({ where: { id: record.id, state: "PUBLISHING",
      publishLeaseUntil: { lt: new Date() } }, data: { publisherId: owner, publishLeaseUntil: later(PUBLISH_LEASE_MS) } });
    if (!claim.count) continue;
    try {
      if (!record.stagingKey) throw new Error("Missing staged object");
      if (await backend.head(record.objectKey) !== Number(record.storedBytes)) {
        await verifyBlob(record, backend, record.stagingKey);
        await backend.copy(record.stagingKey, record.objectKey, Number(record.storedBytes));
      }
      await verifyBlob(record, backend);
      await db.storedBlob.updateMany({ where: { id: record.id, publisherId: owner, state: "PUBLISHING" },
        data: { state: "READY", stagingKey: null, publishLeaseUntil: null, verifiedAt: new Date() } });
      recovered++;
    } catch (error) {
      console.error("Object recovery failed", { id: record.id, error });
      await db.storedBlob.updateMany({ where: { id: record.id, publisherId: owner },
        data: { publishLeaseUntil: later(PUBLISH_LEASE_MS) } });
    }
  }
  return recovered;
}

export async function cleanupObjects(backend: ObjectBackend = s3(), limit = 30) {
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const transfers = await db.blobTransfer.findMany({ where: { updatedAt: { lt: old } },
    take: limit, orderBy: { updatedAt: "asc" } });
  let cleanedStages = 0;
  for (const transfer of transfers) {
    if (await db.storedBlob.count({ where: { state: "PUBLISHING", stagingKey: transfer.stagingKey } })) continue;
    try {
      if (transfer.uploadId && transfer.state === "ACTIVE")
        await backend.abort(transfer.stagingKey, transfer.uploadId).catch(() => {});
      await backend.delete(transfer.stagingKey);
      await db.blobTransfer.delete({ where: { id: transfer.id } });
      cleanedStages++;
    } catch (error) { console.error("Staging cleanup failed", { id: transfer.id, error }); }
  }
  const candidates = await db.storedBlob.findMany({ where: { state: "READY",
    retainUntil: { lt: new Date() } }, take: limit });
  for (const candidate of candidates) {
    await db.$transaction(async tx => {
      await tx.$queryRawUnsafe("SELECT id FROM \"StoredBlob\" WHERE id = $1 FOR UPDATE", candidate.id);
      const current = await tx.storedBlob.findUnique({ where: { id: candidate.id } });
      if (!current || current.state !== "READY" || current.retainUntil > new Date()) return;
      const leases = await tx.blobLease.count({ where: { objectId: candidate.id, expiresAt: { gt: new Date() } } });
      const references = await tx.sourceFileOperation.count({ where: { objectId: candidate.id } });
      if (leases || references) return;
      await tx.storedBlob.update({ where: { id: candidate.id }, data: { state: "DELETING" } });
      // Do not remove grants until physical deletion is committed; DELETING blocks new readers.
    });
  }
  const deleting = await db.storedBlob.findMany({ where: { state: "DELETING" }, take: limit });
  let deleted = 0;
  for (const record of deleting) {
    try {
      await backend.delete(record.objectKey);
      await db.$transaction(async tx => {
        await tx.blobLease.deleteMany({ where: { objectId: record.id } });
        const external = await tx.sourceObject.findFirst({
          where: { id: record.id, externalId: record.id }, select: { id: true },
        });
        if (external) {
          await tx.sourceObjectGrant.deleteMany({ where: { objectId: record.id } });
          await tx.sourceObject.delete({ where: { id: record.id } });
        }
        await tx.storedBlob.delete({ where: { id: record.id, state: "DELETING" } });
      });
      deleted++;
    } catch (error) { console.error("Object garbage collection failed", { id: record.id, error }); }
  }
  metric("cleanup", { deleted, cleanedStages });
  return { deleted, cleanedStages };
}

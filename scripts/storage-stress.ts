import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { Readable } from "node:stream";
import { db } from "../src/lib/prisma";
import { uploadBlob, verifiedBlobStream } from "../src/object-store/service";
import { cleanupObjects } from "../src/object-store/service";

// Physical 3-GiB upload and download through MinIO + PostgreSQL with constant-sized input.
// The sample is deliberately incompressible across deflate's 32-KiB history window.
// In CI, a temporary repository is automatically created and cleaned.
const provided = process.env.STORAGE_STRESS_REPOSITORY_ID;
const suffix = randomBytes(8).toString("hex");
const user = provided ? null : await db.user.create({ data: {
  handle: "stress-" + suffix, email: "stress-" + suffix + "@example.invalid",
} });
const repo = provided ? null : await db.repository.create({ data: {
  ownerId: user!.id, slug: "storage-stress", name: "Storage Stress",
} });
const repositoryId = provided || repo!.id;
const bytes = 3 * 1024 * 1024 * 1024;
const chunk = randomBytes(64 * 1024);
const expected = createHash("sha256").update("BLOB\0");
let peakRss = process.memoryUsage().rss;
let peakHeap = process.memoryUsage().heapUsed;
const sampler = setInterval(() => {
  const current = process.memoryUsage();
  peakRss = Math.max(peakRss, current.rss);
  peakHeap = Math.max(peakHeap, current.heapUsed);
}, 100);
const source = Readable.from((async function* () {
  for (let n = 0; n < bytes / chunk.length; n++) {
    expected.update(chunk);
    yield chunk;
  }
})());
const started = Date.now();
let uploaded: string | undefined;
try {
  const result = await uploadBlob(repositoryId, source);
  uploaded = result.id;
  assert.equal(result.id, expected.digest("hex"));
  const stored = await db.storedBlob.findUniqueOrThrow({ where: { id: result.id } });
  let received = 0;
  const rawDigest = createHash("sha256");
  for await (const part of await verifiedBlobStream(stored)) {
    const buffer = Buffer.from(part);
    received += buffer.length;
    rawDigest.update(buffer);
  }
  assert.equal(received, bytes);
  assert.equal(rawDigest.digest("hex"), stored.rawSha256);
  assert.ok(peakRss < 512 * 1024 * 1024, "RSS exceeds 512 MiB bounded-memory ceiling");
  console.info(JSON.stringify({ event: "object_storage.stress_measured", bytes,
    encodedBytes: result.storedBytes, peakRss, peakHeap,
    durationMs: Date.now() - started, maxMultipartPartBytes: 16 * 1024 * 1024,
    verified: true, objectId: result.id }));
} finally {
  clearInterval(sampler);
  if (uploaded && repo) {
    await db.blobLease.deleteMany({ where: { repositoryId, objectId: uploaded } });
    await db.storedBlob.update({ where: { id: uploaded }, data: { retainUntil: new Date(0) } });
    await cleanupObjects();
  }
  if (repo) {
    await db.blobTransfer.deleteMany({ where: { repositoryId } });
    await db.repository.delete({ where: { id: repositoryId } });
    await db.user.delete({ where: { id: user!.id } });
  }
  await db.$disconnect();
}

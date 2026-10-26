import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { Readable } from "node:stream";
import { db } from "../src/lib/prisma";
import { uploadBlob, verifiedBlobStream } from "../src/object-store/service";

// Optional external, multi-GiB physical I/O benchmark; not part of quick CI.
// Requires STORAGE_STRESS_REPOSITORY_ID pointing to a real writable test repo.
// Creates 3 GiB of data without allocating a 3 GiB buffer.
const repositoryId = process.env.STORAGE_STRESS_REPOSITORY_ID;
if (!repositoryId) throw new Error("Set STORAGE_STRESS_REPOSITORY_ID to a test repository UUID");
const bytes = 3 * 1024 * 1024 * 1024;
const chunk = randomBytes(64 * 1024); // larger than gzip's window: does not compress away I/O
const expected = createHash("sha256").update("BLOB\0");
let peakRss = process.memoryUsage().rss;
const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 200);
const source = Readable.from((async function* () {
  for (let n = 0; n < bytes / chunk.length; n++) { expected.update(chunk); yield chunk; }
})());
const started = Date.now();
try {
  const result = await uploadBlob(repositoryId, source);
  assert.equal(result.id, expected.digest("hex"));
  const stored = await db.storedBlob.findUniqueOrThrow({ where: { id: result.id } });
  let received = 0;
  for await (const part of await verifiedBlobStream(stored)) received += (part as Buffer).length;
  assert.equal(received, bytes);
  console.info(JSON.stringify({ bytes, peakRss, durationMs: Date.now() - started,
    maxMultipartPartBytes: 16 * 1024 * 1024, objectId: result.id }));
  assert.ok(peakRss < 512 * 1024 * 1024, "RSS exceeds bounded-memory ceiling");
} finally { clearInterval(sampler); }

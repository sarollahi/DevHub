import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { db } from "../src/lib/prisma";
import { uploadBlob, verifiedBlobStream, verifyBlob, cleanupObjects, recoverPublications } from "../src/object-store/service";
import { s3, objectKey } from "../src/object-store/s3";
import { createChangeset, getTree } from "../src/source-control/service";

const idOf = (bytes: Buffer) => createHash("sha256").update("BLOB\0").update(bytes).digest("hex");
const upload = (repoId: string, bytes: Buffer) => uploadBlob(repoId, Readable.from([bytes]));
const expired = () => new Date(Date.now() - 48 * 3600 * 1000);

test("immutable S3 objects with real PostgreSQL and MinIO", { timeout: 180000 }, async t => {
  const suffix = randomBytes(7).toString("hex");
  const user = await db.user.create({ data: {
    handle: "blob-" + suffix, email: "blob-" + suffix + "@example.invalid",
  } });
  const repo = await db.repository.create({ data: { ownerId: user.id, slug: "object-test", name: "Object test" } });
  const actor = { id: user.id, type: "HUMAN" as const };
  const owned: string[] = [];
  const changesets: string[] = [];
  const trees: string[] = [];
  const backend = s3();
  t.after(async () => {
    await db.sourceReference.deleteMany({ where: { repositoryId: repo.id } });
    await db.sourceChangeApproval.deleteMany({ where: { changesetId: { in: changesets } } });
    await db.sourceValidation.deleteMany({ where: { changesetId: { in: changesets } } });
    await db.sourceFileOperation.deleteMany({ where: { changesetId: { in: changesets } } });
    await db.sourceChangesetParent.deleteMany({ where: { changesetId: { in: changesets } } });
    await db.sourceChangeset.deleteMany({ where: { id: { in: changesets } } });
    await db.sourceObject.deleteMany({ where: { id: { in: [...trees, ...owned] } } });
    await db.auditEvent.deleteMany({ where: { repositoryId: repo.id } });
    await db.blobLease.deleteMany({ where: { repositoryId: repo.id } });
    await db.blobTransfer.deleteMany({ where: { repositoryId: repo.id } });
    await db.repository.delete({ where: { id: repo.id } });
    await db.user.delete({ where: { id: user.id } });
    for (const objectId of owned) {
      await backend.delete(objectKey(objectId)).catch(() => {});
      await db.storedBlob.deleteMany({ where: { id: objectId } });
    }
  });

  await t.test("empty and binary files round trip; object identities reflect raw bytes", async () => {
    for (const bytes of [Buffer.alloc(0), Buffer.from([0, 255, 13, 10, 128]), randomBytes(70000)]) {
      const receipt = await upload(repo.id, bytes);
      owned.push(receipt.id);
      assert.equal(receipt.id, idOf(bytes));
      assert.equal(receipt.rawBytes, String(bytes.length));
      const row = await db.storedBlob.findUniqueOrThrow({ where: { id: receipt.id } });
      assert.equal(row.state, "READY");
      const received: Buffer[] = [];
      for await (const part of await verifiedBlobStream(row)) received.push(Buffer.from(part));
      assert.deepEqual(Buffer.concat(received), bytes);
    }
  });

  await t.test("parallel and repeated upload results converge to one real object", async () => {
    const bytes = randomBytes(200000);
    const results = await Promise.all(Array.from({ length: 5 }, () => upload(repo.id, bytes)));
    owned.push(results[0].id);
    assert.equal(new Set(results.map(r => r.id)).size, 1);
    assert.equal(results.filter(r => !r.deduplicated).length, 1);
    assert.equal(await db.storedBlob.count({ where: { id: results[0].id } }), 1);
    assert.equal((await upload(repo.id, bytes)).deduplicated, true);
  });

  await t.test("changesets link actual blobs, preserve executable modes and symbolic links", async () => {
    const target = Buffer.from("scripts/run.sh", "utf8");
    const file = Buffer.from("#!/bin/sh\necho safe\n", "utf8");
    const link = await upload(repo.id, target);
    const exec = await upload(repo.id, file);
    owned.push(link.id, exec.id);
    const change = await createChangeset(repo.id, actor, { apiVersion: 1, parents: [],
      message: "Publish file modes", operations: [
        { kind: "PUT", path: "scripts/run.sh", objectId: exec.id, fileMode: "100755" },
        { kind: "PUT", path: "bin/run", objectId: link.id, fileMode: "120000" },
      ] });
    changesets.push(change.id); trees.push(change.treeId);
    assert.deepEqual((await getTree(repo.id, change.id)).entries, [
      { path: "bin/run", objectId: link.id, mode: "120000" },
      { path: "scripts/run.sh", objectId: exec.id, mode: "100755" },
    ]);
    await db.storedBlob.updateMany({ where: { id: exec.id }, data: { retainUntil: expired() } });
    await db.blobLease.updateMany({ where: { objectId: exec.id }, data: { expiresAt: expired() } });
    await cleanupObjects(backend);
    assert.equal((await db.storedBlob.findUniqueOrThrow({ where: { id: exec.id } })).state, "READY");
  });

  await t.test("corruption is detected; an orphan can be garbage collected", async () => {
    const bytes = randomBytes(701);
    const receipt = await upload(repo.id, bytes);
    owned.push(receipt.id);
    const replacement = "staging/test-corrupt/" + randomUUID();
    const uploadId = await backend.initiate(replacement);
    const part = await backend.part(replacement, uploadId, 1, Buffer.from("invalid gzip content"));
    await backend.complete(replacement, uploadId, [part]);
    await backend.copy(replacement, objectKey(receipt.id), 20);
    const row = await db.storedBlob.findUniqueOrThrow({ where: { id: receipt.id } });
    await assert.rejects(() => verifyBlob(row, backend), /gzip|incorrect|header|integrity/i);
    await backend.delete(replacement);
    await db.storedBlob.update({ where: { id: receipt.id }, data: { retainUntil: expired() } });
    await db.blobLease.update({ where: { repositoryId_objectId: {
      repositoryId: repo.id, objectId: receipt.id } }, data: { expiresAt: expired() } });
    const cleaned = await cleanupObjects(backend);
    assert.ok(cleaned.deleted > 0);
    assert.equal(await db.storedBlob.findUnique({ where: { id: receipt.id } }), null);
  });

  await t.test("expired publication is recovered from real staged bytes", async () => {
    const bytes = randomBytes(2048);
    const objectId = idOf(bytes);
    const staging = "staging/" + repo.id + "/" + randomUUID();
    const compressed = gzipSync(bytes);
    const multipart = await backend.initiate(staging);
    const part = await backend.part(staging, multipart, 1, compressed);
    await backend.complete(staging, multipart, [part]);
    owned.push(objectId);
    try {
      await db.storedBlob.create({ data: {
        id: objectId,
        objectKey: objectKey(objectId),
        state: "PUBLISHING",
        stagingKey: staging,
        publisherId: randomUUID(),
        publishLeaseUntil: expired(),
        retainUntil: new Date(Date.now() + 86400000),
        encoding: "gzip",
        rawSha256: createHash("sha256").update(bytes).digest("hex"),
        rawBytes: BigInt(bytes.length),
        storedBytes: BigInt(compressed.length),
      } });
      assert.equal(await recoverPublications(backend), 1);
      const published = await db.storedBlob.findUniqueOrThrow({ where: { id: objectId } });
      assert.equal(published.state, "READY");
      await verifyBlob(published, backend);
      const received: Buffer[] = [];
      for await (const chunk of await verifiedBlobStream(published, backend)) received.push(Buffer.from(chunk));
      assert.deepEqual(Buffer.concat(received), bytes);
    } finally {
      await backend.delete(staging);
    }
  });

  await t.test("interrupted multipart transfers remain durable and are later aborted", async () => {
    const id = randomUUID();
    const stage = "staging/" + repo.id + "/" + id;
    const multipart = await backend.initiate(stage);
    await db.blobTransfer.create({ data: {
      id, repositoryId: repo.id, stagingKey: stage, uploadId: multipart, state: "ACTIVE",
    } });
    await db.blobTransfer.update({ where: { id }, data: { updatedAt: expired() } });
    const state = await cleanupObjects(backend);
    assert.ok(state.cleanedStages >= 1);
    assert.equal(await db.blobTransfer.findUnique({ where: { id } }), null);
  });
});

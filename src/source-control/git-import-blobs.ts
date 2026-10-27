import { createHash } from "node:crypto";
import { Transform } from "node:stream";
import { db } from "../lib/prisma";
import { uploadBlob, verifiedBlobStream } from "../object-store/service";
import { gitProcess, gitText } from "./git-io";
import { objectId } from "./storage";

const SHA = /^[a-f0-9]{40}$|^[a-f0-9]{64}$/;

export async function stageGitBlob(repositoryId: string, cwd: string, sha: string, pulse: () => Promise<void>) {
  if (!SHA.test(sha)) throw new Error("Invalid Git blob digest");
  const key = { repositoryId_gitSha: { repositoryId, gitSha: sha } };
  const previous = await db.gitImportBlob.findUnique({ where: key });
  if (previous) {
    const object = await db.sourceObject.findUnique({ where: { id: previous.objectId } });
    if (!object || object.kind !== "BLOB") throw new Error("Persisted Git blob mapping is dangling");
    return previous.objectId;
  }
  const size = Number((await gitText(cwd, ["cat-file", "-s", sha], 64)).trim());
  if (!Number.isSafeInteger(size) || size < 0 || size > 100 * 1024 * 1024 * 1024) {
    throw new Error("Git object exceeds the 100 GiB streaming storage limit");
  }
  if ((await gitText(cwd, ["cat-file", "-t", sha], 64)).trim() !== "blob") {
    throw new Error("Git source references a non-blob object");
  }
  await pulse();
  const child = gitProcess(cwd, ["cat-file", "blob", sha]);
  const original = createHash(sha.length === 40 ? "sha1" : "sha256").update("blob " + size + "\0");
  let received = 0;
  const validate = new Transform({
    transform(piece: Buffer, _, callback) {
      received += piece.length;
      if (received > size) return callback(new Error("Git object is larger than its metadata"));
      original.update(piece);
      callback(null, piece);
    },
  });
  child.stdout.on("error", error => validate.destroy(error));
  child.stdout.pipe(validate);
  try {
    const stored = await uploadBlob(repositoryId, validate);
    await child.exited;
    if (received !== size || original.digest("hex") !== sha) {
      throw new Error("Git blob integrity validation failed for " + sha);
    }
    await db.gitImportBlob.createMany({
      data: [{ repositoryId, gitSha: sha, objectId: stored.id }], skipDuplicates: true,
    });
    const persisted = await db.gitImportBlob.findUniqueOrThrow({ where: key });
    if (persisted.objectId !== stored.id) throw new Error("Conflicting Git blob mapping");
    await pulse();
    return stored.id;
  } catch (error) {
    child.kill();
    validate.destroy();
    void child.exited.catch(() => undefined);
    throw error;
  }
}

// Reads with bounded capture while hashing the entire physical object.
// Large-file verification never allocates the full payload.
export async function verifyAndReadBlob(_reader: unknown, id: string, captureLimit = 4097): Promise<Buffer> {
  const object = await db.sourceObject.findUnique({ where: { id } });
  if (!object || object.kind !== "BLOB") throw new Error("Native object is not a blob");
  const captured: Buffer[] = [];
  let capturedBytes = 0, total = 0;
  const hash = createHash("sha256").update("BLOB\0");
  const accept = (part: Buffer) => {
    total += part.length;
    hash.update(part);
    if (capturedBytes < captureLimit) {
      const prefix = part.subarray(0, captureLimit - capturedBytes);
      captured.push(prefix);
      capturedBytes += prefix.length;
    }
  };
  if (object.data !== null) {
    accept(Buffer.from(object.data));
  } else {
    if (object.externalId !== id) throw new Error("Native blob missing external storage reference");
    const stored = await db.storedBlob.findFirst({ where: { id, state: "READY" } });
    if (!stored) throw new Error("Native blob is unavailable in external storage");
    for await (const part of await verifiedBlobStream(stored)) accept(Buffer.from(part));
  }
  if (BigInt(total) !== object.byteSize || hash.digest("hex") !== id) {
    throw new Error("Native content-addressed blob is corrupt");
  }
  return Buffer.concat(captured);
}

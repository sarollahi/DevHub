import { db } from "../lib/prisma";
import { verifiedBlobStream } from "../object-store/service";
import { objectId as contentId } from "../source-control/storage";

export const MAX_INDEXED_BYTES = 256 * 1024;

export async function enqueueSearchObjects(ids: string[]) {
  const unique = [...new Set(ids)].filter(id => /^[a-f0-9]{64}$/.test(id));
  for (let offset = 0; offset < unique.length; offset += 500) {
    await db.sourceSearchDocument.createMany({
      data: unique.slice(offset, offset + 500).map(objectId => ({ objectId })),
      skipDuplicates: true,
    });
  }
}

export function indexableText(bytes: Uint8Array): { text: string | null; reason: string | null } {
  if (bytes.length > MAX_INDEXED_BYTES) return { text: null, reason: "TOO_LARGE" };
  if (bytes.includes(0)) return { text: null, reason: "BINARY" };
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), reason: null };
  } catch { return { text: null, reason: "NON_UTF8" }; }
}

export async function indexSearchObject(id: string): Promise<boolean> {
  const now = new Date();
  const lease = await db.sourceSearchDocument.updateMany({ where: {
    objectId: id, nextAttemptAt: { lte: now }, OR: [{ state: "QUEUED" }, { state: "RUNNING", leaseUntil: { lt: now } }],
  }, data: { state: "RUNNING", attempts: { increment: 1 },
    leaseUntil: new Date(now.getTime() + 90_000), lastError: null } });
  if (!lease.count) return false;
  try {
    const source = await db.sourceObject.findFirstOrThrow({ where: { id, kind: "BLOB" } });
    let result: { text: string | null; reason: string | null };
    if (source.byteSize > BigInt(MAX_INDEXED_BYTES)) {
      result = { text: null, reason: "TOO_LARGE" };
    } else if (source.data) {
      if (contentId("BLOB", source.data) !== id) throw Error("Blob integrity mismatch");
      result = indexableText(source.data);
    } else {
      if (source.externalId !== id) throw Error("Invalid external blob identity");
      const stored = await db.storedBlob.findFirstOrThrow({ where: { id, state: "READY" } });
      const fragments: Buffer[] = [];
      let size = 0;
      for await (const part of await verifiedBlobStream(stored)) {
        size += part.length;
        if (size > MAX_INDEXED_BYTES) throw Error("Stored blob exceeds indexed size");
        fragments.push(Buffer.from(part));
      }
      result = indexableText(Buffer.concat(fragments));
    }
    await db.sourceSearchDocument.update({ where: { objectId: id }, data: {
      state: "SUCCEEDED", textBody: result.text, excludedReason: result.reason,
      indexedAt: new Date(), leaseUntil: null, lastError: null,
    } });
    return true;
  } catch (error) {
    const job = await db.sourceSearchDocument.findUniqueOrThrow({ where: { objectId: id } });
    await db.sourceSearchDocument.update({ where: { objectId: id }, data: {
      state: job.attempts >= 5 ? "FAILED" : "QUEUED", leaseUntil: null,
      lastError: error instanceof Error ? error.message.slice(0, 500) : "Indexing failed",
      nextAttemptAt: new Date(Date.now() + Math.min(30000, 800 * 2 ** Math.min(job.attempts, 5))),
    } });
    return false;
  }
}

export async function indexSearchBatch(size = 32) {
  const now = new Date();
  const records = await db.sourceSearchDocument.findMany({ where: {
    nextAttemptAt: { lte: now }, OR: [{ state: "QUEUED" }, { state: "RUNNING", leaseUntil: { lt: now } }],
  }, orderBy: { nextAttemptAt: "asc" }, take: Math.min(100, Math.max(1, size)),
  select: { objectId: true } });
  let completed = 0;
  for (const record of records) if (await indexSearchObject(record.objectId)) completed++;
  return { inspected: records.length, completed };
}

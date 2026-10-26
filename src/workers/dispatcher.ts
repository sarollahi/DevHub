import { db } from "../lib/prisma";
import { createQueue, type ProcessMessage } from "../lib/queue";
import { retryDelayMs } from "../lib/review-logic";

type OutboxRow = { id: string; payload: unknown; attempts: number };
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const batchSize = Math.min(200, Math.max(1, Number(process.env.OUTBOX_BATCH_SIZE ?? 50)));

export async function dispatchBatch(queue = createQueue()): Promise<number> {
  // Atomic DB claim: multiple dispatchers can run without stealing the same row.
  const rows = await db.$queryRaw<OutboxRow[]>`
    WITH pending AS (
      SELECT id FROM "OutboxEvent" WHERE state = 'PENDING'
      AND "nextAttemptAt" <= now()
      AND ("lockedUntil" IS NULL OR "lockedUntil" < now())
      ORDER BY "createdAt" ASC FOR UPDATE SKIP LOCKED LIMIT ${batchSize}
    )
    UPDATE "OutboxEvent" e SET "lockedUntil" = now() + interval '30 seconds'
    FROM pending WHERE e.id = pending.id
    RETURNING e.id, e.payload, e.attempts
  `;
  for (const row of rows) {
    try {
      const data = row.payload as ProcessMessage;
      if (!data.jobId || !data.pullId || !data.version) throw new Error("Invalid outbox payload");
      // Stable ID in Redis + persistent QueueJob guard make at-least-once delivery safe.
      await queue.add("pr-preflight", data, { jobId: data.jobId.replaceAll("-", "") });
      await db.outboxEvent.updateMany({ where: { id: row.id, state: "PENDING" }, data: {
        state: "PUBLISHED", publishedAt: new Date(), lockedUntil: null,
      } });
    } catch (error) {
      const delay = retryDelayMs(row.attempts + 1);
      await db.outboxEvent.update({ where: { id: row.id }, data: {
        attempts: { increment: 1 }, nextAttemptAt: new Date(Date.now() + delay),
        lockedUntil: null,
      } });
      console.error("Outbox delivery deferred:", row.id, error instanceof Error ? error.message : "unknown error");
    }
  }
  return rows.length;
}

async function main() {
  const queue = createQueue();
  let stopping = false;
  process.on("SIGINT", () => { stopping = true; });
  process.on("SIGTERM", () => { stopping = true; });
  try {
    while (!stopping) {
      try { const count = await dispatchBatch(queue); if (!count) await pause(750); }
      catch (error) { console.error("Dispatcher retry:", error); await pause(2000); }
    }
  } finally { await queue.close(); await db.$disconnect(); }
}
if (process.argv[1]?.endsWith("dispatcher.ts")) main().catch((error) => { console.error(error); process.exitCode = 1; });

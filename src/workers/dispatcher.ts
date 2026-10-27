import { measured } from "../observability/telemetry";
import { db } from "../lib/prisma";
import { Queue } from "bullmq";
import { createQueue, redisConnection, type ProcessMessage } from "../lib/queue";
import { retryDelayMs } from "../lib/review-logic";

type OutboxRow = { id: string; payload: unknown; attempts: number };
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const batchSize = Math.min(200, Math.max(1, Number(process.env.OUTBOX_BATCH_SIZE ?? 50)));

export async function dispatchBatch(queue = createQueue()): Promise<number> {
  // Atomic DB claim: multiple dispatchers can run without stealing the same row.
  const rows = await db.$queryRaw<OutboxRow[]>`
    WITH pending AS (
      SELECT id FROM "OutboxEvent" WHERE "aggregateType" = 'PullRequest' AND state = 'PENDING'
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

// Separate durable event lane. Reference mutations cannot enter the
// pull-request preflight queue, which requires a QueueJob and pullId.
export async function dispatchReferenceBatch(queue: Queue): Promise<number> {
  const rows = await db.$queryRaw<OutboxRow[]>`
    WITH pending AS (
      SELECT id FROM "OutboxEvent"
      WHERE "aggregateType" = 'SourceReference' AND state = 'PENDING'
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
      const event = row.payload as { eventId?: string; newGeneration?: number };
      if (!event.eventId || !event.newGeneration) throw new Error("Malformed reference event");
      await queue.add("source-ref-mutated", event, { jobId: row.id.replaceAll("-", "") });
      await db.outboxEvent.updateMany({ where: { id: row.id, state: "PENDING" },
        data: { state: "PUBLISHED", publishedAt: new Date(), lockedUntil: null } });
    } catch (error) {
      await db.outboxEvent.update({ where: { id: row.id },
        data: { attempts: { increment: 1 }, nextAttemptAt: new Date(Date.now() + retryDelayMs(row.attempts + 1)),
          lockedUntil: null } });
      console.error("Reference event deferred:", row.id, error instanceof Error ? error.message : "unknown error");
    }
  }
  return rows.length;
}

async function main() {
  const queue = createQueue();
  const refQueue = new Queue("devhub-source-ref-events", { connection: redisConnection() });
  let stopping = false;
  process.on("SIGINT", () => { stopping = true; });
  process.on("SIGTERM", () => { stopping = true; });
  try {
    while (!stopping) {
      try { const count = (await measured("worker.dispatch", () => dispatchBatch(queue))) + (await measured("worker.dispatch", () => dispatchReferenceBatch(refQueue))); if (!count) await pause(750); }
      catch (error) { console.error("Dispatcher retry:", error); await pause(2000); }
    }
  } finally { await queue.close(); await refQueue.close(); await db.$disconnect(); }
}
if (process.argv[1]?.endsWith("dispatcher.ts")) main().catch((error) => { console.error(error); process.exitCode = 1; });

import { measured } from "../observability/telemetry";
import { db } from "../lib/prisma";
import { Queue } from "bullmq";
import { createQueue, redisConnection, type ProcessMessage } from "../lib/queue";
import { retryDelayMs } from "../lib/review-logic";

type OutboxRow = { id: string; payload: unknown; attempts: number; lockedUntil: Date };
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
    RETURNING e.id, e.payload, e.attempts, e."lockedUntil"
  `;
  for (const row of rows) {
    try {
      const data = row.payload as ProcessMessage;
      if (!data.jobId || !data.pullId || !data.version) throw new Error("Invalid outbox payload");
      // Stable ID in Redis + persistent QueueJob guard make at-least-once delivery safe.
      await queue.add("pr-preflight", data, { jobId: data.jobId.replaceAll("-", "") + (row.attempts ? "-r" + row.attempts : "") });
      await db.outboxEvent.updateMany({ where: { id: row.id, state: "PENDING", lockedUntil: row.lockedUntil }, data: {
        state: "PUBLISHED", publishedAt: new Date(), lockedUntil: null,
      } });
    } catch (error) {
      const delay = retryDelayMs(row.attempts + 1);
      await db.outboxEvent.updateMany({ where: { id: row.id, state: "PENDING", lockedUntil: row.lockedUntil }, data: {
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
    RETURNING e.id, e.payload, e.attempts, e."lockedUntil"
  `;
  for (const row of rows) {
    try {
      const event = row.payload as { eventId?: string; newGeneration?: number };
      if (!event.eventId || !event.newGeneration) throw new Error("Malformed reference event");
      await queue.add("source-ref-mutated", event, { jobId: row.id.replaceAll("-", "") });
      await db.outboxEvent.updateMany({ where: { id: row.id, state: "PENDING", lockedUntil: row.lockedUntil },
        data: { state: "PUBLISHED", publishedAt: new Date(), lockedUntil: null } });
    } catch (error) {
      await db.outboxEvent.updateMany({ where: { id: row.id, state: "PENDING", lockedUntil: row.lockedUntil },
        data: { attempts: { increment: 1 }, nextAttemptAt: new Date(Date.now() + retryDelayMs(row.attempts + 1)),
          lockedUntil: null } });
      console.error("Reference event deferred:", row.id, error instanceof Error ? error.message : "unknown error");
    }
  }
  return rows.length;
}

// Redis jobs are volatile transport hints. If a durable job remains QUEUED
// after an outbox publish, replay it under a fresh transport ID. This is safe
// across dispatchers: source-of-truth is QueueJob, not BullMQ completion state.
export async function reclaimUndeliveredPreflight(limit = 50): Promise<number> {
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    WITH candidates AS (
      SELECT e.id FROM "OutboxEvent" e
      JOIN "QueueJob" j ON e.payload->>'jobId' = j.id::text
      WHERE e."aggregateType"='PullRequest' AND e.state='PUBLISHED'
        AND j.state='QUEUED'
        AND e."publishedAt" < now() - interval '5 minutes'
      ORDER BY e."publishedAt" ASC
      FOR UPDATE OF e SKIP LOCKED LIMIT ${Math.min(200, Math.max(1, limit))}
    )
    UPDATE "OutboxEvent" e SET state='PENDING', "attempts"=e.attempts+1,
      "publishedAt"=NULL, "lockedUntil"=NULL, "nextAttemptAt"=now()
    FROM candidates c WHERE e.id=c.id RETURNING e.id`;
  return rows.length;
}

async function main() {
  const queue = createQueue();
  const refQueue = new Queue("devhub-source-ref-events", { connection: redisConnection() });
  let stopping = false;
  process.on("SIGINT", () => { stopping = true; });
  process.on("SIGTERM", () => { stopping = true; });
  let lastSweep = 0;
  try {
    while (!stopping) {
      try {
        if (Date.now() - lastSweep > 30_000) {
          lastSweep = Date.now();
          await reclaimUndeliveredPreflight();
        }
        const count = (await measured("worker.dispatch", () => dispatchBatch(queue))) + (await measured("worker.dispatch", () => dispatchReferenceBatch(refQueue))); if (!count) await pause(750); }
      catch (error) { console.error("Dispatcher retry:", error); await pause(2000); }
    }
  } finally { await queue.close(); await refQueue.close(); await db.$disconnect(); }
}
if (process.argv[1]?.endsWith("dispatcher.ts")) main().catch((error) => { console.error(error); process.exitCode = 1; });

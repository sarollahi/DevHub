import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { db } from "../src/lib/prisma";
import { tokenHash, authenticateAgent } from "../src/lib/auth";
import { ingestPullRequest, IngestError } from "../src/services/ingest";
import { createQueue, redisConnection } from "../src/lib/queue";
import { dispatchBatch } from "../src/workers/dispatcher";
import { createPreflightWorker, processPreflight } from "../src/workers/processor";
import { POST as approve } from "../src/app/api/v1/pull-requests/[id]/approve/route";

test("real PostgreSQL and Redis: admission, outbox, durable retries and human approval", { timeout: 60000 }, async (t) => {
  const unique = randomBytes(7).toString("hex");
  const user = await db.user.create({ data: { handle: `integration-${unique}`, email: `${unique}@example.invalid` } });
  const outsider = await db.user.create({ data: { handle: `outsider-${unique}`, email: `outside-${unique}@example.invalid` } });
  const repo = await db.repository.create({ data: { ownerId: user.id, name: "Integration", slug: "integration", requireHumanApproval: true } });
  const agent = await db.agentIdentity.create({ data: { ownerId: user.id, name: "integration", scopes: ["pull_requests:write"] } });
  const forbiddenAgent = await db.agentIdentity.create({ data: { ownerId: outsider.id, name: "integration", scopes: ["pull_requests:write"] } });
  const secret = randomBytes(32).toString("hex");
  await db.agentCredential.create({ data: { agentId: agent.id, tokenHash: tokenHash(secret), label: "integration" } });
  const queueConnection = redisConnection();
  const queue = createQueue(queueConnection);
  let worker: ReturnType<typeof createPreflightWorker> | undefined;
  const workerConnection = redisConnection();
  const ids: string[] = [];

  t.after(async () => {
    if (worker) await worker.close();
    await queue.obliterate({ force: true });
    await queue.close();
    await queueConnection.quit();
    await workerConnection.quit();
    await db.outboxEvent.deleteMany({ where: { aggregateId: { in: ids } } });
    await db.auditEvent.deleteMany({ where: { repositoryId: repo.id } });
    await db.pullRequest.deleteMany({ where: { repositoryId: repo.id } });
    await db.ingressBucket.deleteMany({ where: { repositoryId: repo.id } });
    await db.repository.delete({ where: { id: repo.id } });
    await db.agentIdentity.deleteMany({ where: { ownerId: { in: [user.id, outsider.id] } } });
    await db.user.deleteMany({ where: { id: { in: [user.id, outsider.id] } } });
    await db.$disconnect();
  });

  const input = {
    repository: `${user.handle}/integration`,
    title: "Verify end-to-end admission",
    sourceBranch: "feature/integration",
    sourceSha: "a".repeat(40),
    targetBranch: "develop",
    targetSha: "b".repeat(40),
    changedFiles: ["src/feature.ts"],
    patch: "diff --git a/src/feature.ts b/src/feature.ts\\n+export const verified = true;",
  };

  await t.test("credentials and repository authorization are enforced", async () => {
    const authenticated = await authenticateAgent(
      new NextRequest("http://localhost/api/v1/pull-requests", { headers: { authorization: `Bearer ${secret}` } }),
      "pull_requests:write",
    );
    assert.equal(authenticated?.id, agent.id);
    assert.equal(await authenticateAgent(
      new NextRequest("http://localhost/api/v1/pull-requests", { headers: { authorization: `Bearer ${secret}` } }),
      "repositories:admin",
    ), null);
    await assert.rejects(
      () => ingestPullRequest(forbiddenAgent, input, `forbidden-${unique}`),
      (error: unknown) => error instanceof IngestError && error.status === 403,
    );
    assert.equal(await db.pullRequest.count({ where: { repositoryId: repo.id } }), 0);
  });

  const key = `once-${unique}`;
  const first = await ingestPullRequest(agent, input, key);
  ids.push(first.item.id);
  await t.test("idempotent creation persists job and outbox atomically", async () => {
    assert.equal(first.created, true);
    const replay = await ingestPullRequest(agent, input, key);
    assert.equal(replay.created, false);
    assert.equal(replay.item.id, first.item.id);
    await assert.rejects(
      () => ingestPullRequest(agent, { ...input, patch: "+different change" }, key),
      (error: unknown) => error instanceof IngestError && error.status === 409,
    );
    assert.equal(await db.pullRequest.count({ where: { repositoryId: repo.id } }), 1);
    assert.equal(await db.queueJob.count({ where: { pullId: first.item.id } }), 1);
    assert.equal(await db.outboxEvent.count({ where: { aggregateId: first.item.id, state: "PENDING" } }), 1);
  });

  await t.test("outbox delivery and persisted preflight are safe to replay", async () => {
    assert.equal(await dispatchBatch(queue), 1);
    const job = await db.queueJob.findFirstOrThrow({ where: { pullId: first.item.id } });
    const event = await db.outboxEvent.findFirstOrThrow({ where: { aggregateId: first.item.id } });
    assert.equal(event.state, "PUBLISHED");
    assert.ok(await queue.getJob(job.id.replaceAll("-", "")));
    await db.outboxEvent.update({ where: { id: event.id }, data: { state: "PENDING", publishedAt: null } });
    assert.equal(await dispatchBatch(queue), 1);
    assert.equal(await db.outboxEvent.count({ where: { aggregateId: first.item.id, state: "PUBLISHED" } }), 1);
    await processPreflight({ jobId: job.id, pullId: first.item.id, version: 1 });
    await processPreflight({ jobId: job.id, pullId: first.item.id, version: 1 });
    assert.equal(await db.queueJob.findUniqueOrThrow({ where: { id: job.id } }).then((j) => j.state), "SUCCEEDED");
    assert.equal(await db.checkRun.count({ where: { pullId: first.item.id, state: "SUCCESS" } }), 1);
  });

  await t.test("metadata-only PR cannot be approved without signed executable checks", async () => {
    const endpoint = `http://localhost:3000/api/v1/pull-requests/${first.item.id}/approve`;
    const params = { params: Promise.resolve({ id: first.item.id }) };
    const denied = await approve(new NextRequest(endpoint, { method: "POST", headers: { authorization: `Bearer ${secret}` } }), params);
    assert.equal(denied.status, 401);
    assert.equal(await db.approval.count({ where: { pullId: first.item.id } }), 0);
    const accepted = await approve(new NextRequest(endpoint, { method: "POST", headers: {
      authorization: `Bearer ${process.env.ADMIN_TOKEN}`,
    } }), params);
    assert.equal(accepted.status, 409);
    assert.equal(await db.approval.count({ where: { pullId: first.item.id } }), 0);
    assert.equal((await db.pullRequest.findUniqueOrThrow({ where: { id: first.item.id } })).state, "REVIEW_REQUIRED");
    assert.equal((await approve(new NextRequest(endpoint, { method: "POST", headers: {
      authorization: `Bearer ${process.env.ADMIN_TOKEN}`,
    } }), params)).status, 409);
  });

  await t.test("production worker retries a failed attempt and commits a single result", async () => {
    const second = await ingestPullRequest(agent, { ...input, title: "Retry integration", sourceBranch: "feature/retry" }, `retry-${unique}`);
    ids.push(second.item.id);
    const job = await db.queueJob.findFirstOrThrow({ where: { pullId: second.item.id } });
    await db.pullRequest.update({ where: { id: second.item.id }, data: { changedFiles: ["../invalid"] } });
    await dispatchBatch(queue);
    let failures = 0;
    worker = createPreflightWorker(workerConnection, 1);
    const completion = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Worker did not recover after retry")), 30000);
      worker!.on("failed", (queuedJob) => {
        if (queuedJob?.data.jobId !== job.id) return;
        failures++;
        void db.pullRequest.update({ where: { id: second.item.id }, data: { changedFiles: input.changedFiles } })
          .catch((error) => { clearTimeout(timer); reject(error); });
      });
      worker!.on("completed", (queuedJob) => {
        if (queuedJob.data.jobId !== job.id) return;
        clearTimeout(timer);
        resolve();
      });
      worker!.on("error", (error) => { clearTimeout(timer); reject(error); });
    });
    await completion;
    assert.ok(failures >= 1);
    const durable = await db.queueJob.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(durable.state, "SUCCEEDED");
    assert.ok(durable.attempts >= 2);
    assert.equal(await db.checkRun.count({ where: { pullId: second.item.id, state: "SUCCESS" } }), 1);
  });
});

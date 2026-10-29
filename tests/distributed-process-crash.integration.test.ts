import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { db } from "../src/lib/prisma";
import { processPreflight } from "../src/workers/processor";

function waitForClaim(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let text = "";
    const timeout = setTimeout(() => reject(new Error("Worker did not claim before deadline")), 10_000);
    child.stdout!.on("data", (part: Buffer) => {
      text += part.toString("utf8");
      if (text.includes("PREFLIGHT_LEASE_CLAIMED:")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.once("exit", code => {
      clearTimeout(timeout);
      reject(new Error("Worker exited before claim: " + code));
    });
  });
}

test("actual SIGKILL during preflight lease is reclaimed and publishes exactly once", {
  timeout: 60_000,
}, async () => {
  const suffix = randomBytes(5).toString("hex");
  const user = await db.user.create({ data: {
    handle: "crash-" + suffix, email: "crash-" + suffix + "@example.test",
  } });
  const repo = await db.repository.create({ data: {
    ownerId: user.id, slug: "crash-" + suffix, name: "Crash recovery fixture",
  } });
  const agent = await db.agentIdentity.create({ data: {
    ownerId: user.id, name: "crash-" + suffix, scopes: ["changesets:write"],
  } });
  const pull = await db.pullRequest.create({ data: {
    repositoryId: repo.id, agentId: agent.id, idempotencyKey: "crash-" + suffix,
    requestHash: "c".repeat(64), title: "Reclaim durable preflight",
    sourceBranch: "feature/crash", sourceSha: "a".repeat(40),
    targetBranch: "main", targetSha: "b".repeat(40),
    changedFiles: ["README.md"], patch: "+recover\n",
  } });
  const item = await db.queueJob.create({ data: {
    pullId: pull.id, kind: "preflight", idempotencyKey: "preflight-crash-" + suffix,
  } });
  const payload = { jobId: item.id, pullId: pull.id, version: pull.version };
  const child = spawn(process.execPath, [
    "--import", "tsx", "scripts/preflight-fault-child.ts",
    item.id, pull.id, String(pull.version),
  ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "test",
      DEVHUB_TEST_HOLD_PREFLIGHT: "isolated-ci",
      DEVHUB_FAULT_DRILL: "isolated-local-only" } });
  try {
    await waitForClaim(child);
    assert.equal((await db.queueJob.findUniqueOrThrow({ where: { id: item.id } })).state, "RUNNING");
    // The worker is actually terminated. Expiry is accelerated in SQL rather
    // than making CI sleep for a two-minute lease period.
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await exited;
    await db.queueJob.update({ where: { id: item.id },
      data: { leaseUntil: new Date(Date.now() - 1000) } });
    await processPreflight(payload);
    await processPreflight(payload); // stale Redis transport replay
    const finished = await db.queueJob.findUniqueOrThrow({ where: { id: item.id } });
    assert.equal(finished.state, "SUCCEEDED");
    assert.equal(finished.attempts, 2);
    assert.equal(finished.leaseToken, null);
    assert.equal(await db.checkRun.count({ where: {
      pullId: pull.id, name: "metadata-validation", state: "SUCCESS",
    } }), 1);
    assert.equal(await db.auditEvent.count({ where: {
      repositoryId: repo.id, action: "pull_request.preflight_completed",
    } }), 1);
    console.log(JSON.stringify({ drill: "sigkill_preflight", status: "PASS",
      attempts: finished.attempts, committedChecks: 1, recovery: "lease-expiry-and-CAS" }));
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});

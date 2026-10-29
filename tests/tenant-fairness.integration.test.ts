import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { db } from "../src/lib/prisma";
import { stageCanonicalBlob, createCanonicalChangeset } from "../src/source-control/canonical";
import { fairCandidates, fairClaim } from "../src/workers/tenant-scheduler";

test("durable tenant turn alternates independent index work under cross-worker claims", {
  timeout: 50_000,
}, async () => {
  const suffix = randomBytes(5).toString("hex");
  const tenants: Array<{ tenantId: string; jobs: string[] }> = [];
  for (let i = 0; i < 2; i++) {
    const user = await db.user.create({ data: {
      handle: "fair-" + i + "-" + suffix, email: "fair-" + i + "-" + suffix + "@example.test",
    } });
    const repo = await db.repository.create({ data: {
      ownerId: user.id, slug: "fair-" + suffix, name: "Fair queue " + i,
      defaultBranch: "main", requireHumanApproval: false,
    } });
    const session = await db.humanSession.create({ data: {
      userId: user.id, tokenHash: randomBytes(32).toString("hex"),
      expiresAt: new Date(Date.now() + 3_600_000),
    } });
    const actor = { type: "HUMAN" as const, id: user.id, sessionId: session.id };
    const jobs: string[] = [];
    let parent: string | undefined;
    for (let j = 0; j < 2; j++) {
      const blob = await stageCanonicalBlob(repo.id, actor,
        Buffer.from("fairness-" + i + "-" + j).toString("base64"));
      const change = await createCanonicalChangeset(repo.id, actor, {
        apiVersion: 2, parents: parent ? [parent] : [],
        description: "Fair candidate " + i + ":" + j,
        operations: [{ kind: parent ? "MODIFY" : "ADD", path: "fairness.txt", objectId: blob.id }],
      });
      parent = change.id;
      jobs.push(change.id);
      await db.sourceQueryIndexJob.createMany({ data: [{
        repositoryId: repo.id, changesetId: change.id,
      }], skipDuplicates: true });
    }
    tenants.push({ tenantId: user.id, jobs });
  }
  const own = new Set(tenants.map(t => t.tenantId));
  const before = (await fairCandidates("source-index")).filter(c => own.has(c.tenantId));
  assert.equal(before.length, 2, "One candidate must be exposed per tenant, not per queued changeset");
  const first = before[0];
  const chosen = await fairClaim("source-index", first.tenantId, async tx => {
    const token = randomUUID();
    const updated = await tx.sourceQueryIndexJob.updateMany({ where: {
      changesetId: first.id, state: "QUEUED",
    }, data: {
      state: "RUNNING", leaseToken: token,
      leaseUntil: new Date(Date.now() + 90_000), attempts: { increment: 1 },
    } });
    return updated.count ? token : null;
  });
  assert.ok(chosen, "Fair claim must acquire one durable job");
  const turn = await db.tenantLaneTurn.findUniqueOrThrow({
    where: { lane_tenantId: { lane: "source-index", tenantId: first.tenantId } },
  });
  assert.equal(turn.claimCount, 1n);
  const after = (await fairCandidates("source-index")).filter(c => own.has(c.tenantId));
  assert.equal(after.length, 2);
  assert.notEqual(after[0].tenantId, first.tenantId,
    "After serving tenant A, the unserved tenant B must get the next turn");
  // A worker crash cannot permanently consume its slot: only an unexpired
  // RUNNING canonical job counts toward the tenant's active capacity.
  await db.sourceQueryIndexJob.update({ where: { changesetId: first.id },
    data: { leaseUntil: new Date(Date.now()-1000) } });
  const reclaim = await fairClaim("source-index", first.tenantId, async tx => {
    const token = randomUUID();
    const updated = await tx.sourceQueryIndexJob.updateMany({ where: {
      changesetId: first.id, state: "RUNNING", leaseUntil: { lt: new Date() },
    }, data: { leaseToken: token, leaseUntil: new Date(Date.now() + 90_000) } });
    return updated.count ? token : null;
  });
  assert.ok(reclaim, "Expired work must be reclaimable across instances");
});

test("concurrent first-time tenant scheduling initializes a single durable turn without unique-key errors", {
  timeout: 30_000,
}, async t => {
  const tenantId = randomUUID();
  t.after(async () => {
    await db.tenantLaneTurn.deleteMany({ where: { lane: "review", tenantId } });
  });
  // All processes enter fairClaim against the same initially absent PK.
  // The old empty-update Prisma upsert raised P2002 intermittently.
  const attempts = await Promise.allSettled(Array.from({ length: 24 }, () =>
    fairClaim("review", tenantId, async () => true)));
  assert.equal(attempts.filter(x => x.status === "rejected").length, 0,
    "Concurrent first-time claims must not fail a unique key race");
  const rows = await db.tenantLaneTurn.findMany({ where: { lane: "review", tenantId } });
  assert.equal(rows.length, 1, "Tenant scheduler must have one canonical row");
  assert.ok(rows[0].claimCount >= 0n);
});

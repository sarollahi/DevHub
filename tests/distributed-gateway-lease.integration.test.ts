import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { db } from "../src/lib/prisma";
import { acquireGitLease, renewGitLease, releaseGitLease, requireGitLease } from "../src/source-control/git-lease";

test("independent gateway contenders cannot hold the same PostgreSQL lease", async () => {
  const repositoryId = randomUUID();
  const first = await acquireGitLease(repositoryId, 0);
  try {
    await assert.rejects(acquireGitLease(repositoryId, 0), /Another Git session is active/);
    assert.equal(await renewGitLease(repositoryId, first), true);
    await requireGitLease(repositoryId, first);
    // Real DB-time expiration simulates loss of heartbeat during a partition.
    await db.$executeRaw`
      UPDATE "GitGatewayLease" SET "expiresAt"=now()-interval '1 second'
      WHERE "repositoryId"=${repositoryId}::uuid`;
    assert.equal(await renewGitLease(repositoryId, first), false);
    await assert.rejects(requireGitLease(repositoryId, first), /lease lost/);
    const second = await acquireGitLease(repositoryId, 0);
    try {
      assert.notEqual(second, first);
      await releaseGitLease(repositoryId, first);
      assert.equal(await renewGitLease(repositoryId, second), true,
        "a stale gateway must not clear a newer replica's lease");
    } finally {
      await releaseGitLease(repositoryId, second);
    }
  } finally {
    await releaseGitLease(repositoryId, first);
  }
});

test("a simultaneous lease race admits exactly one contender", async () => {
  const repositoryId = randomUUID();
  const outcomes = await Promise.allSettled([
    acquireGitLease(repositoryId, 0), acquireGitLease(repositoryId, 0),
  ]);
  const winners = outcomes.filter((o): o is PromiseFulfilledResult<string> => o.status === "fulfilled");
  try { assert.equal(winners.length, 1); }
  finally { for (const winner of winners) await releaseGitLease(repositoryId, winner.value); }
});

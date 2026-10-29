import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { db } from "../src/lib/prisma";
import { stageCanonicalBlob, createCanonicalChangeset } from "../src/source-control/canonical";
import { mutateReference } from "../src/source-control/refs";

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

test("API SIGKILL before PostgreSQL ref-transaction commit rolls back ref, outbox and journal", {
  timeout: 70_000,
}, async () => {
  const suffix = randomBytes(6).toString("hex");
  const func = "devhub_ref_crash_fn_" + suffix;
  const trigger = "devhub_ref_crash_tr_" + suffix;
  const mutationId = "ref-crash-" + suffix;
  const user = await db.user.create({ data: {
    handle: "cas-kill-" + suffix, email: "cas-kill-" + suffix + "@example.test",
  } });
  const repo = await db.repository.create({ data: {
    ownerId: user.id, slug: "cas-kill-" + suffix, name: "CAS crash test",
    defaultBranch: "main", requireHumanApproval: false,
  } });
  const session = await db.humanSession.create({ data: {
    userId: user.id, tokenHash: randomBytes(32).toString("hex"),
    expiresAt: new Date(Date.now()+3_600_000),
  } });
  const actor = { type: "HUMAN" as const, id: user.id, sessionId: session.id };
  const first = await stageCanonicalBlob(repo.id, actor, Buffer.from("before\n").toString("base64"));
  const base = await createCanonicalChangeset(repo.id, actor, {
    apiVersion: 2, parents: [], description: "Pre-crash content",
    operations: [{ kind: "ADD", path: "probe.txt", objectId: first.id }],
  });
  const second = await stageCanonicalBlob(repo.id, actor, Buffer.from("after\n").toString("base64"));
  const next = await createCanonicalChangeset(repo.id, actor, {
    apiVersion: 2, parents: [base.id], description: "Post-crash content",
    operations: [{ kind: "MODIFY", path: "probe.txt", objectId: second.id }],
  });
  const original = await mutateReference(repo.id, actor, {
    name: "dev", kind: "BRANCH", operation: "CREATE", changesetId: base.id,
    expectedGeneration: null, mutationId: "initial-" + suffix,
  });
  // The trigger holds the *real* native mutation transaction open, after
  // reference CAS but before the journal/outbox commit. This is not a
  // simulated exception and not a normal service restart.
  await db.$executeRawUnsafe(`CREATE FUNCTION "${func}"() RETURNS trigger AS $$
    BEGIN IF NEW."mutationId" = '${mutationId}' THEN
      PERFORM pg_sleep(35);
    END IF; RETURN NEW; END;
    $$ LANGUAGE plpgsql`);
  await db.$executeRawUnsafe(`CREATE TRIGGER "${trigger}" BEFORE INSERT ON "SourceRefMutation"
    FOR EACH ROW EXECUTE FUNCTION "${func}"()`);
  const child = spawn(process.execPath, ["--import","tsx","scripts/ref-crash-child.ts",
    repo.id,user.id,session.id,next.id,String(original.generation),mutationId],
    { cwd: process.cwd(), stdio: ["ignore","pipe","pipe"], env: process.env });
  try {
    // pg_stat_activity confirms the genuine PostgreSQL sleep fault was reached.
    let entered = false;
    for (let i = 0; i < 80; i++) {
      const sleepers = await db.$queryRaw<Array<{ sleepers: bigint }>>`
        SELECT COUNT(*)::bigint AS sleepers FROM pg_stat_activity
        WHERE wait_event='PgSleep' AND query LIKE '%SourceRefMutation%'`;
      if (sleepers[0]?.sleepers > 0n) { entered = true; break; }
      if (child.exitCode !== null) break;
      await sleep(200);
    }
    assert.equal(entered, true, "Child did not reach PostgreSQL journal insert faultpoint");
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await exited;
    // The connection is now closed, so PostgreSQL must roll back every write
    // from the incomplete native transaction including the ref CAS itself.
    const unchanged = await db.sourceReference.findUniqueOrThrow({
      where: { repositoryId_name: { repositoryId: repo.id, name: "dev" } },
    });
    assert.equal(unchanged.changesetId, base.id);
    assert.equal(unchanged.generation, original.generation);
    assert.equal(await db.sourceRefMutation.count({ where: {
      repositoryId: repo.id, name: "dev", mutationId,
    } }), 0);
    assert.equal(await db.outboxEvent.count({ where: {
      aggregateType: "SourceReference", kind: "SOURCE_REFERENCE_MUTATED",
      payload: { path: ["mutationId"], equals: mutationId },
    } }), 0);
    await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${trigger}" ON "SourceRefMutation"`);
    await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${func}"()`);
    const retry = await mutateReference(repo.id, actor, {
      name: "dev", kind: "BRANCH", operation: "UPDATE",
      expectedGeneration: original.generation, changesetId: next.id, mutationId,
    });
    assert.equal(retry.changesetId, next.id);
    assert.equal(await db.sourceRefMutation.count({ where: {
      repositoryId: repo.id, name: "dev", mutationId,
    } }), 1);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${trigger}" ON "SourceRefMutation"`).catch(() => {});
    await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${func}"()`).catch(() => {});
  }
});

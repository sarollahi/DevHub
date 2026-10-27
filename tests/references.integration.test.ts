import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { db } from "../src/lib/prisma";
import { createChangeset, approveChangeset } from "../src/source-control/service";
import { mutateReference, updateReferencePolicy, referenceHistory } from "../src/source-control/refs";
import { SourceControlError } from "../src/source-control/contracts";
import { objectId } from "../src/source-control/storage";
import { testSession } from "./support/identities";

test("authoritative refs: CAS, immutable tags, policy, tombstones, history, and rollback", { timeout: 120000 }, async t => {
  const suffix = randomBytes(6).toString("hex");
  const user = await db.user.create({ data: { handle: "ref-" + suffix, email: "ref-" + suffix + "@example.invalid" } });
  const repo = await db.repository.create({ data: { ownerId: user.id, slug: "refs", name: "Refs " + suffix, defaultBranch: "bootstrap-staging" } });
  const { actor } = await testSession(user.id);
  const changes: { id: string; treeId: string }[] = [];
  const blobs: string[] = [];
  const writeChange = async (parent: string | undefined, name: string) => {
    const data = Buffer.from(name, "utf8");
    const entry = await createChangeset(repo.id, actor, { apiVersion: 1, parents: parent ? [parent] : [],
      message: name, operations: [{ kind: "PUT", path: "file/" + name + ".txt", dataBase64: data.toString("base64") }] });
    changes.push({ id: entry.id, treeId: entry.treeId });
    blobs.push(objectId("BLOB", data));
    await approveChangeset(repo.id, entry.id, actor);
    return entry.id;
  };
  t.after(async () => {
    await db.auditEvent.deleteMany({ where: { repositoryId: repo.id } });
    await db.outboxEvent.deleteMany({ where: { aggregateId: repo.id } });
    // Journal rows and policies cascade with repository deletion. References do not.
    await db.sourceReference.deleteMany({ where: { repositoryId: repo.id } });
    await db.sourceChangeApproval.deleteMany({ where: { changesetId: { in: changes.map(c => c.id) } } });
    await db.sourceValidation.deleteMany({ where: { changesetId: { in: changes.map(c => c.id) } } });
    await db.sourceFileOperation.deleteMany({ where: { changesetId: { in: changes.map(c => c.id) } } });
    await db.sourceChangesetParent.deleteMany({ where: { changesetId: { in: changes.map(c => c.id) } } });
    await db.sourceChangeset.deleteMany({ where: { id: { in: changes.map(c => c.id) } } });
    await db.sourceObject.deleteMany({ where: { id: { in: [...blobs, ...changes.map(c => c.treeId)] } } });
    await db.repository.delete({ where: { id: repo.id } });
    await db.user.delete({ where: { id: user.id } });
  });
  const root = await writeChange(undefined, "root-" + suffix);
  const left = await writeChange(root, "left-" + suffix);
  const right = await writeChange(root, "right-" + suffix);
  const child = await writeChange(left, "child-" + suffix);
  const request = (name: string, operation: "CREATE" | "UPDATE" | "DELETE" | "RESTORE",
    expectedGeneration: number | null, changesetId?: string, id = randomUUID()) =>
      ({ name, operation, expectedGeneration, changesetId, mutationId: id });
  const fail = (code: string) => (e: unknown) => e instanceof SourceControlError && e.code === code;

  await t.test("creation is idempotent, and a default branch cannot lose updates", async () => {
    const input = request("main", "CREATE", null, root);
    const created = await mutateReference(repo.id, actor, input);
    assert.equal(created.ref.generation, 1);
    await db.repository.update({where:{id:repo.id},data:{defaultBranch:"main"}});
    assert.equal((await mutateReference(repo.id, actor, input)).replayed, true);
    assert.equal(await db.sourceRefMutation.count({ where: { repositoryId: repo.id, name: "main" } }), 1);
    await assert.rejects(() => mutateReference(repo.id, actor, { ...input, changesetId: left }), fail("MUTATION_ID_REUSED"));
    // The first true advance wins; the other must not overwrite it.
    // No legacy direct-update API may bypass protected integration validation.
    await assert.rejects(() => mutateReference(repo.id, actor, request("main", "UPDATE", 1, left)), fail("INTEGRATION_REQUIRED"));
    const row = await db.sourceReference.findUniqueOrThrow({ where: { repositoryId_name: { repositoryId: repo.id, name: "main" } } });
    assert.equal(row.generation, 1);
    assert.equal(row.changesetId, root);
    const name = "branches/default-race";
    await mutateReference(repo.id, actor, request(name, "CREATE", null, root));
    const results = await Promise.allSettled([
      mutateReference(repo.id, actor, request(name, "UPDATE", 1, left, "race-left")),
      mutateReference(repo.id, actor, request(name, "UPDATE", 1, right, "race-right")),
    ]);
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(results.filter(r => r.status === "rejected").length, 1);
    const winner = results[0].status === "fulfilled" ? left : right;
    const advanced = await db.sourceReference.findUniqueOrThrow({ where: { repositoryId_name: { repositoryId: repo.id, name } } });
    assert.equal(advanced.generation, 2);
    assert.equal(advanced.changesetId, winner);
    await assert.rejects(() => mutateReference(repo.id, actor, request(name, "UPDATE", 1, child)), fail("REFERENCE_CONFLICT"));
    await assert.rejects(() => mutateReference(repo.id, actor, {
      ...request("main", "UPDATE", 1, root), force: true, reason: "Try to rewrite default branch",
    }), fail("PROTECTED_REFERENCE"));
    await assert.rejects(() => mutateReference(repo.id, actor, request("main", "DELETE", 1)), fail("PROTECTED_REFERENCE"));
  });

  await t.test("tags never move; policy gates force and protected branches", async () => {
    await mutateReference(repo.id, actor, request("tags/v1", "CREATE", null, root));
    await assert.rejects(() => mutateReference(repo.id, actor, request("tags/v1", "UPDATE", 1, left)), fail("IMMUTABLE_TAG"));
    await assert.rejects(() => mutateReference(repo.id, actor, request("tags/v1", "DELETE", 1)), fail("IMMUTABLE_TAG"));
    await mutateReference(repo.id, actor, request("branches/preview", "CREATE", null, left));
    await assert.rejects(() => mutateReference(repo.id, actor, request("branches/preview", "UPDATE", 1, right)), fail("NON_FAST_FORWARD"));
    await updateReferencePolicy(repo.id, actor, "branches/preview",
      { protected: false, allowForce: true, allowDelete: true, requireApproval: false });
    const forced = await mutateReference(repo.id, actor, { ...request("branches/preview", "UPDATE", 1, right),
      force: true, reason: "Explicitly reset preview pointer" });
    assert.equal(forced.ref.generation, 2);
    const protectedPolicy={ protected: true, allowForce: false, allowDelete: false, requireApproval: true };
    await assert.rejects(() => updateReferencePolicy(repo.id, actor, "branches/preview", protectedPolicy),
      fail("REVIEW_REQUIRED"));
    // Fixture: simulate a previously protected ref to test deletion guards.
    await db.sourceReferencePolicy.upsert({where:{repositoryId_name:{
      repositoryId:repo.id,name:"branches/preview"
    }},create:{repositoryId:repo.id,name:"branches/preview",...protectedPolicy},
      update:protectedPolicy});
    await assert.rejects(() => mutateReference(repo.id, actor, request("branches/preview", "DELETE", 2)), fail("PROTECTED_REFERENCE"));
    await assert.rejects(() => updateReferencePolicy(repo.id, actor, "main",
      { protected: false, allowForce: true, allowDelete: true, requireApproval: false }), fail("DEFAULT_BRANCH_PROTECTED"));
  });

  await t.test("deletion and restoration preserve generations and audit every successful mutation", async () => {
    const name = "branches/ephemeral";
    await mutateReference(repo.id, actor, request(name, "CREATE", null, root));
    const deleted = await mutateReference(repo.id, actor, request(name, "DELETE", 1));
    assert.equal(deleted.ref.deleted, true);
    assert.equal(deleted.ref.generation, 2);
    assert.equal(await db.sourceReference.count({ where: { repositoryId: repo.id, name, deletedAt: null } }), 0);
    await assert.rejects(() => mutateReference(repo.id, actor, request(name, "CREATE", null, left)), fail("REFERENCE_CONFLICT"));
    await assert.rejects(() => mutateReference(repo.id, actor, request(name, "RESTORE", 1, root)), fail("REFERENCE_CONFLICT"));
    const restored = await mutateReference(repo.id, actor, request(name, "RESTORE", 2, root));
    assert.equal(restored.ref.generation, 3);
    assert.equal(restored.ref.deleted, false);
    const history = await referenceHistory(repo.id, name, 100, undefined, actor);
    assert.deepEqual(history.map(h => h.operation), ["RESTORE", "DELETE", "CREATE"]);
    assert.equal(await db.auditEvent.count({ where: { repositoryId: repo.id, action: { startsWith: "reference." }, metadata: { path: ["name"], equals: name } } }), 3);
    assert.equal(await db.outboxEvent.count({ where: { aggregateId: repo.id, aggregateType: "SourceReference",
      payload: { path: ["name"], equals: name } } }), 3);
    await assert.rejects(() => db.sourceRefMutation.delete({ where: { id: history[0].id } }));
  });

  await t.test("hundreds of competing writers produce one winning update per observed generation", { timeout: 90000 }, async () => {
    const name = "branches/hot";
    await mutateReference(repo.id, actor, request(name, "CREATE", null, root));
    const attempts = Array.from({ length: 240 }, (_, i) => request(name, "UPDATE", 1, i % 2 ? left : right, "writer-" + suffix + "-" + i));
    // Schedule all 240 writers together; the database is responsible for
    // serialization on the hot row while unrelated refs remain independent.
    const outcomes = await Promise.allSettled(attempts.map(input => mutateReference(repo.id, actor, input)));
    assert.equal(outcomes.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(outcomes.filter(r => r.status === "rejected").length, 239);
    assert.equal((await db.sourceReference.findUniqueOrThrow({ where: { repositoryId_name: { repositoryId: repo.id, name } } })).generation, 2);
    assert.equal(await db.sourceRefMutation.count({ where: { repositoryId: repo.id, name } }), 2);
  });

  await t.test("rollback preserves target, history and outbox when transaction aborts", async () => {
    const name = "branches/rollback-" + suffix;
    await mutateReference(repo.id, actor, request(name, "CREATE", null, root));
    const functionName = "reject_ref_outbox_" + suffix;
    const triggerName = "reject_ref_event_" + suffix;
    await db.$executeRawUnsafe(`CREATE FUNCTION "${functionName}"() RETURNS trigger AS $$
      BEGIN
        IF NEW."aggregateType" = 'SourceReference' AND NEW.payload->>'name' = '${name}' AND NEW.payload->>'action' = 'UPDATE' THEN
          RAISE EXCEPTION 'injected event delivery failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`);
    await db.$executeRawUnsafe(`CREATE TRIGGER "${triggerName}" BEFORE INSERT ON "OutboxEvent"
      FOR EACH ROW EXECUTE FUNCTION "${functionName}"()`);
    try {
      await assert.rejects(() => mutateReference(repo.id, actor, request(name, "UPDATE", 1, left)));
      const current = await db.sourceReference.findUniqueOrThrow({ where: { repositoryId_name: { repositoryId: repo.id, name } } });
      assert.equal(current.generation, 1);
      assert.equal(current.changesetId, root);
      assert.equal(await db.sourceRefMutation.count({ where: { repositoryId: repo.id, name } }), 1);
      assert.equal(await db.outboxEvent.count({ where: { aggregateId: repo.id, aggregateType: "SourceReference",
        payload: { path: ["name"], equals: name } } }), 1);
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER "${triggerName}" ON "OutboxEvent"`);
      await db.$executeRawUnsafe(`DROP FUNCTION "${functionName}"()`);
    }
    assert.equal((await mutateReference(repo.id, actor, request(name, "UPDATE", 1, left))).ref.generation, 2);
  });
});

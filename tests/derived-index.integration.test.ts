import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { db } from "../src/lib/prisma";
import { objectId } from "../src/source-control/storage";
import { createChangeset } from "../src/source-control/service";
import { runAuthorizedQuery, fileHistory, ancestryQuery, mergeBases, blameQuery } from "../src/source-control/query";
import { DERIVED_VERSION, enqueueDerived, processDerivedBatch, processDerivedIndex,
  readDerived, checksum, stableJson } from "../src/source-control/derived-index";
import { indexedFileHistory, indexedLinearMergeBases, IndexedWalk } from "../src/source-control/derived-queries";
import { testSession } from "./support/identities";

const put = (path: string, content: string) => ({
  kind: "PUT" as const, path, dataBase64: Buffer.from(content).toString("base64"),
});

test("versioned recursive indexes agree with canonical history and survive lost leases", { timeout: 120_000 }, async t => {
  const suffix = randomBytes(8).toString("hex");
  const owner = await db.user.create({ data: { handle: "derived-" + suffix, email: suffix + "@example.invalid" } });
  const repository = await db.repository.create({ data: { ownerId: owner.id, slug: "derived", name: "Derived test" } });
  const actor = (await testSession(owner.id)).actor;
  const created: string[] = [];
  const objects = new Set<string>();
  const blobs = new Set<string>();
  async function add(parents: string[], message: string, operations: {
    kind: "PUT" | "DELETE" | "MOVE"; path: string; previousPath?: string; dataBase64?: string;
  }[]) {
    const result = await createChangeset(repository.id, actor, {
      apiVersion: 1, parents, message, operations,
    });
    created.push(result.id);
    objects.add(result.treeId);
    for (const op of operations) if (op.dataBase64) blobs.add(objectId("BLOB", Buffer.from(op.dataBase64, "base64")));
    return result.id;
  }
  t.after(async () => {
    await db.sourceDerivedPathEvent.deleteMany({ where: { repositoryId: repository.id } });
    await db.sourceDerivedJump.deleteMany({ where: { repositoryId: repository.id } });
    await db.sourceDerivedIndex.deleteMany({ where: { repositoryId: repository.id } });
    await db.sourceQueryPathTouch.deleteMany({ where: { changesetId: { in: created } } });
    await db.sourceQueryIndexJob.deleteMany({ where: { repositoryId: repository.id } });
    await db.sourceChangeApproval.deleteMany({ where: { changesetId: { in: created } } });
    await db.sourceValidation.deleteMany({ where: { changesetId: { in: created } } });
    await db.sourceFileOperation.deleteMany({ where: { changesetId: { in: created } } });
    await db.sourceChangesetParent.deleteMany({ where: { OR: [
      { changesetId: { in: created } }, { parentId: { in: created } },
    ] } });
    await db.sourceChangeset.deleteMany({ where: { id: { in: created } } });
    await db.sourceObject.deleteMany({ where: { id: { in: [...objects, ...blobs] } } });
    await db.auditEvent.deleteMany({ where: { repositoryId: repository.id } });
    await db.repository.delete({ where: { id: repository.id } });
    await db.user.delete({ where: { id: owner.id } });
  });

  const root = await add([], "root", [put("docs/old.txt", "a\nb\n")]);
  const moved = await add([root], "rename", [{ kind: "MOVE", path: "docs/new.txt", previousPath: "docs/old.txt" }]);
  const edit = await add([moved], "edit", [put("docs/new.txt", "a\nc\n")]);
  const sibling = await add([moved], "independent", [put("unrelated.txt", "unrelated\n")]);
  const merge = await add([edit, sibling], "merge", [put("unrelated.txt", "unrelated\n")]);
  const baseline = await runAuthorizedQuery(actor, repository.id,
    () => fileHistory(repository.id, edit, "docs/new.txt"));
  assert.deepEqual(baseline.records.map(x => x.changesetId), [edit, moved, root]);

  // Exercise the expired-lease claim before any index is published.
  await enqueueDerived(repository.id, root, ["ancestry"]);
  await db.sourceDerivedIndex.update({ where: { changesetId_kind_version: {
    changesetId: root, kind: "ancestry", version: DERIVED_VERSION,
  } }, data: { state: "RUNNING", leaseToken: "00000000-0000-4000-8000-000000000001",
    leaseUntil: new Date(Date.now() - 1000) } });
  assert.equal(await processDerivedIndex(root, "ancestry"), true);

  for (const id of [root, moved, edit, sibling, merge]) await enqueueDerived(repository.id, id);
  let done = false;
  for (let batch = 0; batch < 80; batch++) {
    await processDerivedBatch(64);
    const complete = await db.sourceDerivedIndex.count({ where: {
      repositoryId: repository.id, state: "SUCCEEDED",
    } });
    if (complete === 30) { done = true; break; }
  }
  assert.equal(done, true, "all six kinds per revision should finish in DAG order");
  const walk = new IndexedWalk(repository.id);
  assert.equal(await walk.onFirstParentChain(edit, root), true);
  assert.equal(await walk.onFirstParentChain(edit, sibling), false);
  assert.deepEqual(await indexedLinearMergeBases(repository.id, edit, sibling), [moved]);
  assert.equal(await indexedLinearMergeBases(repository.id, merge, edit), null);

  const history = await indexedFileHistory(repository.id, edit, "docs/new.txt", true, 100);
  assert.ok(history);
  assert.deepEqual(history.records.map(x => x.changesetId), baseline.records.map(x => x.changesetId));
  assert.deepEqual(await runAuthorizedQuery(actor, repository.id,
    () => fileHistory(repository.id, edit, "docs/new.txt")), history);
  assert.deepEqual(await runAuthorizedQuery(actor, repository.id,
    () => mergeBases(repository.id, edit, sibling)), [moved]);
  const linear = await runAuthorizedQuery(actor, repository.id, () => ancestryQuery(repository.id, edit, undefined, 10));
  assert.equal(linear.ancestorCount, 2);
  assert.deepEqual(linear.ancestors, [edit, moved, root]);
  const merged = await runAuthorizedQuery(actor, repository.id, () => ancestryQuery(repository.id, merge, sibling, 10));
  assert.equal(merged.ancestorCount, 4);
  const blame = await runAuthorizedQuery(actor, repository.id, () => blameQuery(repository.id, edit, "docs/new.txt"));
  assert.deepEqual(blame.lines.map(x => x.changesetId), [root, edit]);

  const published = await readDerived(repository.id, edit, "ancestry");
  assert.equal(published?.firstParentDepth, 2);
  assert.ok(await db.sourceDerivedJump.count({ where: { changesetId: edit, version: DERIVED_VERSION } }));
  await assert.rejects(db.sourceDerivedIndex.update({ where: { changesetId_kind_version: {
    changesetId: edit, kind: "ancestry", version: DERIVED_VERSION,
  } }, data: { checksum: "0".repeat(64) } }));
  assert.deepEqual(await readDerived(repository.id, edit, "ancestry"), published);
});

test("canonical checksums are object-order independent but content-sensitive", () => {
  assert.equal(stableJson({ z: [1, { y: true, x: false }], a: 2 }),
    stableJson({ a: 2, z: [1, { x: false, y: true }] }));
  assert.equal(checksum({ y: 2, x: 1 }), checksum({ x: 1, y: 2 }));
  assert.notEqual(checksum({ x: 1 }), checksum({ x: 2 }));
});

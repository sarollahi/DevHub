import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { db } from "../src/lib/prisma";
import { objectId } from "../src/source-control/storage";
import { createChangeset } from "../src/source-control/service";
import { runAuthorizedQuery, fileHistory, ancestryQuery, mergeBases, blameQuery, isAncestor, pathImpactQuery, contributionImpactQuery } from "../src/source-control/query";
import { DERIVED_VERSION, enqueueDerived, processDerivedBatch, processDerivedIndex,
  readDerived, checksum, stableJson } from "../src/source-control/derived-index";
import { indexedFileHistory, indexedLinearMergeBases, indexedDagMergeBases, indexedDagIsAncestor, IndexedWalk } from "../src/source-control/derived-queries";
import { testSession } from "./support/identities";
import { exactDagAncestors, exactDagMergeBases } from "../src/source-control/dag-queries";
import { matchingLines, matchingLinesLarge } from "../src/source-control/query-algorithms";

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
    await db.sourceDerivedBlameFile.deleteMany({ where: { repositoryId: repository.id } });
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
  const crossA = await add([edit, sibling], "criss-cross A", [put("cross/a.txt", "A\n")]);
  const crossB = await add([sibling, edit], "criss-cross B", [put("cross/b.txt", "B\n")]);
  const largeText = Array.from({ length: 12_000 }, (_, i) => "line-" + i + "\n").join("");
  const largeRoot = await add([root], "large root", [put("large.txt", largeText)]);
  const largeEdit = await add([largeRoot], "large edit", [put("large.txt",
    largeText.replace("line-6000\n", "NEW-6000\n"))]);
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

  const revisions = [root, moved, edit, sibling, merge, crossA, crossB, largeRoot, largeEdit];
  for (const id of revisions) await enqueueDerived(repository.id, id);
  let done = false;
  for (let batch = 0; batch < 200; batch++) {
    await processDerivedBatch(64);
    const complete = await db.sourceDerivedIndex.count({ where: {
      repositoryId: repository.id, state: "SUCCEEDED",
    } });
    if (complete === revisions.length * 6) { done = true; break; }
  }
  assert.equal(done, true, "all six kinds per revision should finish in DAG order");
  const walk = new IndexedWalk(repository.id);
  assert.equal(await walk.onFirstParentChain(edit, root), true);
  assert.equal(await walk.onFirstParentChain(edit, sibling), false);
  assert.deepEqual(await indexedLinearMergeBases(repository.id, edit, sibling), [moved]);
  assert.equal(await indexedLinearMergeBases(repository.id, merge, edit), null);
  assert.deepEqual(await indexedDagMergeBases(repository.id, crossA, crossB),
    [edit, sibling].sort());
  assert.deepEqual(await exactDagMergeBases(repository.id, crossA, crossB),
    [edit, sibling].sort());
  assert.equal(await indexedDagIsAncestor(repository.id, edit, crossB), true);
  assert.equal(await indexedDagIsAncestor(repository.id, root, crossA), true);
  assert.equal(await indexedDagIsAncestor(repository.id, crossA, crossB), false);
  assert.equal(await runAuthorizedQuery(actor, repository.id,
    () => isAncestor(repository.id, sibling, crossA)), true);
  assert.deepEqual(new Set((await exactDagAncestors(repository.id, crossA, 100)).ancestors),
    new Set([crossA, edit, sibling, moved, root]));

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
  const impact = await runAuthorizedQuery(actor, repository.id,
    () => pathImpactQuery(repository.id, crossA, "docs/old.txt"));
  assert.deepEqual(new Set(impact.records.map(r => r.changesetId)), new Set([root, moved]));
  const contributors = await runAuthorizedQuery(actor, repository.id,
    () => contributionImpactQuery(repository.id, crossA));
  assert.equal(contributors.records.length, 1);
  assert.equal(contributors.records[0].revisions, 5);
  assert.equal(contributors.records[0].operations, 5);
  assert.equal(contributors.records[0].distinctPaths, 4);
  const blame = await runAuthorizedQuery(actor, repository.id, () => blameQuery(repository.id, edit, "docs/new.txt"));
  assert.deepEqual(blame.lines.map(x => x.changesetId), [root, edit]);
  const provenance = await db.sourceDerivedBlameFile.findFirstOrThrow({ where: {
    repositoryId: repository.id, changesetId: edit, version: DERIVED_VERSION,
  } });
  assert.equal(provenance.state, "READY");
  assert.equal(provenance.lineCount, 2);
  const large = await runAuthorizedQuery(actor, repository.id,
    () => blameQuery(repository.id, largeEdit, "large.txt", 500, 5999, 3));
  assert.deepEqual(large.lines.map(line => line.changesetId),
    [largeRoot, largeEdit, largeRoot]);
  assert.equal(large.totalLines, 12000);
  assert.equal(large.nextOffset, 6002);

  const published = await readDerived(repository.id, edit, "ancestry");
  assert.equal(published?.firstParentDepth, 2);
  assert.ok(await db.sourceDerivedJump.count({ where: { changesetId: edit, version: DERIVED_VERSION } }));
  await assert.rejects(db.sourceDerivedIndex.update({ where: { changesetId_kind_version: {
    changesetId: edit, kind: "ancestry", version: DERIVED_VERSION,
  } }, data: { checksum: "0".repeat(64) } }));
  assert.deepEqual(await readDerived(repository.id, edit, "ancestry"), published);
});

test("linear-space provenance matching agrees with independent exact LCS lengths", () => {
  for (let seed = 0; seed < 100; seed++) {
    const oldLines = Array.from({ length: 8 }, (_, i) => "line-" + ((i * 13 + seed) % 5) + "\n");
    const newLines = Array.from({ length: 10 }, (_, i) => "line-" + ((i * 7 + seed) % 5) + "\n");
    const baseline = matchingLines(oldLines, newLines)!;
    const large = matchingLinesLarge(oldLines, newLines);
    assert.equal(large.length, baseline.length);
    for (let i = 0; i < large.length; i++) {
      const [a, b] = large[i];
      assert.equal(oldLines[a], newLines[b]);
      if (i) { assert.ok(a > large[i - 1][0]); assert.ok(b > large[i - 1][1]); }
    }
  }
});

test("canonical checksums are object-order independent but content-sensitive", () => {
  assert.equal(stableJson({ z: [1, { y: true, x: false }], a: 2 }),
    stableJson({ a: 2, z: [1, { x: false, y: true }] }));
  assert.equal(checksum({ y: 2, x: 1 }), checksum({ x: 1, y: 2 }));
  assert.notEqual(checksum({ x: 1 }), checksum({ x: 2 }));
});

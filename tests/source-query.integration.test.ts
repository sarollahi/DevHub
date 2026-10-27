import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { db } from "../src/lib/prisma";
import { objectId, encodeTree } from "../src/source-control/storage";
import { createChangeset } from "../src/source-control/service";
import { testSession } from "./support/identities";
import { compareEntries, mergeEntries, matchingLines } from "../src/source-control/query-algorithms";
import {
  runAuthorizedQuery, ancestryQuery, mergeBases, compareQuery, treeQuery, resolvePath, diffQuery,
  fileHistory, blameQuery, mergeQuery, rebaseQuery, pathImpactQuery,
} from "../src/source-control/query";
import { GET as queryRoute } from "../src/app/api/v1/repositories/[id]/query/[operation]/route";
import { GET as rawRoute } from "../src/app/api/v1/repositories/[id]/objects/[objectId]/raw/route";

const b64 = (text: string) => Buffer.from(text).toString("base64");
const put = (path: string, content: string) => ({ kind: "PUT" as const, path, dataBase64: b64(content) });
function independentAncestors(id: string, parents: Map<string, string[]>) {
  const seen = new Set<string>(); const pending = [id];
  while (pending.length) {
    const head = pending.pop()!;
    if (seen.has(head)) continue;
    seen.add(head);
    pending.push(...(parents.get(head) ?? []));
  }
  return seen;
}
function independentBases(a: string, b: string, parents: Map<string, string[]>) {
  const first = independentAncestors(a, parents);
  const common = [...independentAncestors(b, parents)].filter(n => first.has(n));
  return common.filter(n => !common.some(other => other !== n && independentAncestors(other, parents).has(n))).sort();
}

test("native indexed query APIs agree with independent DAG reference and Git fixtures", { timeout: 90_000 }, async t => {
  const suffix = randomBytes(8).toString("hex");
  const owner = await db.user.create({ data: { handle: "query-" + suffix, email: suffix + "@example.invalid" } });
  const repository = await db.repository.create({ data: { ownerId: owner.id, slug: "query", name: "Query fixtures" } });
  const human = await testSession(owner.id);
  const actor = human.actor;
  const created: string[] = [];
  const treeObjects = new Set<string>();
  const allBlobs = new Set<string>();
  async function add(parents: string[], message: string, operations: {
    kind: "PUT" | "MOVE" | "DELETE"; path: string; dataBase64?: string; previousPath?: string;
  }[]) {
    const result = await createChangeset(repository.id, actor, { apiVersion: 1, parents, message, operations });
    created.push(result.id);
    treeObjects.add(result.treeId);
    for (const op of operations) if (op.dataBase64) allBlobs.add(objectId("BLOB", Buffer.from(op.dataBase64, "base64")));
    return result.id;
  }
  t.after(async () => {
    await db.sourceReference.deleteMany({ where: { repositoryId: repository.id } });
    await db.sourceChangeApproval.deleteMany({ where: { changesetId: { in: created } } });
    await db.sourceValidation.deleteMany({ where: { changesetId: { in: created } } });
    await db.sourceFileOperation.deleteMany({ where: { changesetId: { in: created } } });
    await db.sourceChangesetParent.deleteMany({ where: { OR: [{ changesetId: { in: created } }, { parentId: { in: created } }] } });
    await db.sourceChangeset.deleteMany({ where: { id: { in: created } } });
    await db.sourceObject.deleteMany({ where: { id: { in: [...treeObjects, ...allBlobs] } } });
    await db.auditEvent.deleteMany({ where: { repositoryId: repository.id } });
    await db.repository.delete({ where: { id: repository.id } });
    await db.user.delete({ where: { id: owner.id } });
  });

  await runAuthorizedQuery(actor, repository.id, async () => {
  const root = await add([], "root", [put("docs/a.txt", "one\ntwo\n"), put("src/app.ts", "export const x=1;\n")]);
  const moved = await add([root], "rename", [{ kind: "MOVE", previousPath: "docs/a.txt", path: "docs/b.txt" }]);
  const left = await add([moved], "edit", [put("docs/b.txt", "one\nTWO\n")]);
  const right = await add([moved], "add", [put("src/new.ts", "export const y=2;\n")]);
  const merged = await add([left, right], "merge both", [put("src/new.ts", "export const y=2;\n")]);
  const other = await add([moved], "conflicting edit", [put("docs/b.txt", "different\n")]);
  const parents = new Map<string, string[]>([[root, []], [moved, [root]], [left, [moved]],
    [right, [moved]], [merged, [left, right]], [other, [moved]]]);

  await t.test("ancestry and all lowest common ancestors", async () => {
    assert.deepEqual(await mergeBases(repository.id, left, right), independentBases(left, right, parents));
    assert.deepEqual(await mergeBases(repository.id, merged, other), independentBases(merged, other, parents));
    const result = await ancestryQuery(repository.id, merged, other, 20);
    assert.equal(result.ancestorCount, 4);
    assert.deepEqual(result.mergeBases, [moved]);
    const m1 = await add([left, right], "cross A", [put("cross/a.txt", suffix)]);
    const m2 = await add([right, left], "cross B", [put("cross/b.txt", suffix)]);
    parents.set(m1, [left, right]); parents.set(m2, [right, left]);
    assert.deepEqual(await mergeBases(repository.id, m1, m2), independentBases(m1, m2, parents));
    assert.deepEqual(await mergeBases(repository.id, m1, m2), [left, right].sort());
  });
  await t.test("tree listing, resolution, comparisons and exact rename", async () => {
    const diff = await compareQuery(repository.id, root, moved);
    assert.deepEqual(diff.changes.map(c => c.kind), ["RENAME"]);
    assert.equal(diff.changes[0].previousPath, "docs/a.txt");
    const tree = await treeQuery(repository.id, merged, "", 1);
    assert.equal(tree.entries.length, 1);
    assert.ok(tree.nextCursor);
    const next = await treeQuery(repository.id, merged, "", 20, tree.nextCursor!);
    assert.equal(next.entries.length, 1);
    assert.equal((await resolvePath(repository.id, merged, "docs")).kind, "directory");
    assert.equal((await resolvePath(repository.id, merged, "docs/b.txt")).kind, "file");
    const diffWithPatch = await diffQuery(repository.id, moved, left);
    assert.equal(diffWithPatch.files[0].binary, false);
    assert.match(diffWithPatch.files[0].patch!, /\+TWO/);
  });
  await t.test("file history follows rename and blame attributes unchanged lines", async () => {
    const history = await fileHistory(repository.id, left, "docs/b.txt");
    assert.deepEqual(history.records.map(r => r.changesetId), [left, moved, root]);
    const blame = await blameQuery(repository.id, left, "docs/b.txt");
    assert.deepEqual(blame.lines.map(l => l.changesetId), [root, left]);
    assert.equal(blame.lines[1].text, "TWO\n");
  });
  await t.test("conflict-conservative merge and rebase are side-effect free", async () => {
    const good = await mergeQuery(repository.id, left, right);
    assert.equal(good.clean, true);
    assert.ok(good.entries.some(e => e.path === "src/new.ts"));
    assert.equal((await mergeQuery(repository.id, left, other)).clean, false);
    const id = objectId("BLOB", Buffer.from("same"));
    const original = [{ path: "old", objectId: id }];
    assert.equal(mergeEntries(original, [{ path: "left", objectId: id }], [{ path: "right", objectId: id }]).conflicts.length, 1);
    assert.equal(mergeEntries(original, [{ path: "left", objectId: id }], []).conflicts.length, 1);
    const rebased = await rebaseQuery(repository.id, left, right);
    assert.equal(rebased.clean, true);
    assert.equal(rebased.published, false);
    assert.equal(await db.sourceReference.count({ where: { repositoryId: repository.id } }), 0);
  });
  await t.test("versioned routes enforce auth and stream exact stored bytes", async () => {
    const uri = `http://localhost:3000/api/v1/repositories/${repository.id}`;
    const params = { id: repository.id, operation: "blame" };
    const noAuth = await queryRoute(new NextRequest(uri + "/query/blame?revision=" + left + "&path=docs%2Fb.txt"),
      { params: Promise.resolve(params) });
    assert.equal(noAuth.status, 401);
    const headers = human.headers;
    const response = await queryRoute(new NextRequest(uri + "/query/blame?revision=" + left + "&path=docs%2Fb.txt", { headers }),
      { params: Promise.resolve(params) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).result.lines[0].changesetId, root);
    const obj = objectId("BLOB", Buffer.from("one\nTWO\n"));
    const raw = await rawRoute(new NextRequest(uri + "/objects/" + obj + "/raw", { headers }),
      { params: Promise.resolve({ id: repository.id, objectId: obj }) });
    assert.equal(raw.status, 200);
    assert.equal(await raw.text(), "one\nTWO\n");
  });
  await t.test("worker retries expired leases and builds durable path indexes", async () => {
    const before = await pathImpactQuery(repository.id, left, "docs/a.txt");
    const { indexChangeset } = await import("../src/workers/query-indexer");
    const start = await db.sourceQueryIndexJob.findUniqueOrThrow({ where: { changesetId: root } });
    assert.equal(start.state, "QUEUED");
    await db.sourceQueryIndexJob.update({ where: { changesetId: root }, data: {
      state: "RUNNING", leaseUntil: new Date(Date.now() - 1000),
    } });
    assert.equal(await indexChangeset(root), true);
    assert.equal(await indexChangeset(moved), true);
    const job = await db.sourceQueryIndexJob.findUniqueOrThrow({ where: { changesetId: moved } });
    assert.equal(job.generation, 2);
    assert.equal(job.state, "SUCCEEDED");
    const touch = await db.sourceQueryPathTouch.findMany({ where: { changesetId: moved } });
    assert.deepEqual(touch.map(e => e.path).sort(), ["docs/a.txt", "docs/b.txt"]);
    const after = await pathImpactQuery(repository.id, left, "docs/a.txt");
    assert.deepEqual(after.records, before.records);
  });

  await t.test("Git rename and merge-base oracle", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devhub-query-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
    try {
      git("init", "-q", "-b", "main");
      git("config", "user.name", "Fixture Author");
      git("config", "user.email", "fixture@example.invalid");
      mkdirSync(join(dir, "docs"));
      writeFileSync(join(dir, "docs", "a.txt"), "one\ntwo\n");
      git("add", "."); git("commit", "-qm", "root");
      git("branch", "feature-left");
      git("branch", "feature-right");
      git("checkout", "-q", "feature-left");
      renameSync(join(dir, "docs", "a.txt"), join(dir, "docs", "b.txt"));
      git("add", "-A"); git("commit", "-qm", "rename");
      assert.match(git("diff", "--name-status", "-M", "HEAD~", "HEAD"), /^R100\s+docs\/a.txt\s+docs\/b.txt$/);
      git("checkout", "-q", "feature-right");
      writeFileSync(join(dir, "docs", "other.txt"), "independent\n");
      git("add", "."); git("commit", "-qm", "other");
      const base = git("merge-base", "feature-left", "feature-right");
      assert.equal(base, git("rev-parse", "main"));
      assert.deepEqual(await mergeBases(repository.id, left, right), [moved]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  });
});

test("seeded property tests compare tree algebra with independent map application", () => {
  let seed = 34822;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let trial = 0; trial < 250; trial++) {
    const old = Array.from({ length: 8 }, (_, i) => ({ path: `file-${i}`, objectId: String(Math.floor(rnd() * 5)).padStart(64, "0") }));
    const newer = old.filter(() => rnd() > 0.3).map(e => ({ ...e, objectId: rnd() > 0.7 ? String(Math.floor(rnd() * 5)).padStart(64, "0") : e.objectId }));
    if (rnd() > .5) newer.push({ path: "new", objectId: old[Math.floor(rnd() * old.length)].objectId });
    const changes = compareEntries(old, newer);
    const rebuilt = new Map(old.map(e => [e.path, e.objectId]));
    for (const event of changes) {
      if (event.kind === "RENAME") rebuilt.delete(event.previousPath!);
      if (event.kind === "DELETE") rebuilt.delete(event.path);
      else rebuilt.set(event.path, event.after!);
    }
    assert.deepEqual([...rebuilt].sort(), [...newer.map(e => [e.path, e.objectId] as [string, string])].sort());
    assert.deepEqual(mergeEntries(old, old, newer).entries, [...newer].sort((a, b) => a.path.localeCompare(b.path)));
  }
  assert.deepEqual(matchingLines(["a\n", "b\n"], ["a\n", "c\n"]), [[0, 0]]);
});

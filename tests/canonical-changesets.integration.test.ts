import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { NextRequest } from "next/server";
import { db } from "../src/lib/prisma";
import { tokenHash } from "../src/lib/auth";
import { createCanonicalChangeset, stageCanonicalBlob, getCanonicalChangeset, getCanonicalSnapshot, listCanonicalEvents } from "../src/source-control/canonical";
import { getObject, createChangeset } from "../src/source-control/service";
import { SnapshotTree } from "../src/source-control/snapshot-tree";
import { runAuthorizedQuery, ancestryQuery, compareQuery, treeQuery, resolvePath, fileHistory, blameQuery, pathImpactQuery } from "../src/source-control/query";
import { SourceControlError } from "../src/source-control/contracts";
import { POST as publishApi } from "../src/app/api/v2/repositories/[id]/changesets/route";
import { POST as blobApi } from "../src/app/api/v2/repositories/[id]/objects/route";
import { GET as readApi } from "../src/app/api/v2/repositories/[id]/changesets/[changesetId]/route";

const encode = (data: string | Buffer) => Buffer.from(data).toString("base64");
const expects = (code: string) => (e: unknown) => e instanceof SourceControlError && e.code === code;

test("native delta DAG, PostgreSQL event log and recovery", { timeout: 100000 }, async t => {
  const suffix = randomBytes(8).toString("hex");
  const user = await db.user.create({ data: { handle: "delta-" + suffix, email: "delta-" + suffix + "@example.invalid" } });
  const stranger = await db.user.create({ data: { handle: "other-" + suffix, email: "other-" + suffix + "@example.invalid" } });
  const repo = await db.repository.create({ data: { ownerId: user.id, slug: "delta", name: "Delta" } });
  const foreign = await db.repository.create({ data: { ownerId: stranger.id, slug: "foreign", name: "Foreign" } });
  const agent = await db.agentIdentity.create({ data: { ownerId: user.id, name: "writer", scopes: ["changesets:read", "changesets:write"] } });
  const foreignAgent = await db.agentIdentity.create({ data: { ownerId: stranger.id, name: "writer", scopes: ["changesets:read", "changesets:write"] } });
  const token = randomBytes(32).toString("hex");
  const foreignToken = randomBytes(32).toString("hex");
  await db.agentCredential.createMany({ data: [
    { agentId: agent.id, tokenHash: tokenHash(token), label: "integration", scopes: ["changesets:read", "changesets:write"], expiresAt: new Date(Date.now()+3600000) },
    { agentId: foreignAgent.id, tokenHash: tokenHash(foreignToken), label: "integration", scopes: ["changesets:read", "changesets:write"], expiresAt: new Date(Date.now()+3600000) },
  ] });
  const credential = await db.agentCredential.findUniqueOrThrow({ where: { tokenHash: tokenHash(token) } });
  const foreignCredential = await db.agentCredential.findUniqueOrThrow({ where: { tokenHash: tokenHash(foreignToken) } });
  await db.agentDelegation.createMany({ data: [
    { agentId: agent.id, repositoryId: repo.id, delegatedBy: user.id, scopes: ["changesets:read","changesets:write"], expiresAt: new Date(Date.now()+3600000) },
    { agentId: foreignAgent.id, repositoryId: foreign.id, delegatedBy: stranger.id, scopes: ["changesets:read","changesets:write"], expiresAt: new Date(Date.now()+3600000) },
  ] });
  const actor = { type: "AGENT" as const, id: agent.id, credentialId: credential.id };
  await runAuthorizedQuery(actor, repo.id, async () => {
  const stage = async (raw: string | Buffer) => (await stageCanonicalBlob(repo.id, actor, encode(raw))).id;
  const alpha = await stage("alpha");
  const beta = await stage("beta");
  const empty = await stage("");
  const binary = await stage(Buffer.from([0, 255, 1, 128]));
  const symlink = await stage("docs/a.txt");
  const orphan = await stage("unreferenced orphan");
  const make = (description: string, parents: string[], operations: unknown[], key?: string) =>
    createCanonicalChangeset(repo.id, actor, { apiVersion: 2, description, parents, operations, ...(key ? { idempotencyKey: key } : {}) });

  const rootOps = [
    { kind: "ADD", path: "docs/a.txt", objectId: alpha },
    { kind: "ADD", path: "docs/empty", objectId: empty },
    { kind: "ADD", path: "assets/binary.bin", objectId: binary, mode: "100755" },
  ];
  const root = await make("root", [], rootOps, "root-key");
  await t.test("content identity, delta-only persistence, events, and immutable replay", async () => {
    assert.equal(root.created, true);
    assert.match(root.id, /^[a-f0-9]{64}$/);
    const read = await getCanonicalChangeset(repo.id, root.id, actor);
    assert.equal(read.treeId, null);
    assert.equal(read.operations.length, 3);
    assert.equal(read.authorId, "AGENT:" + agent.id);
    assert.ok(read.createdAt instanceof Date);
    assert.equal((await make("root", [], rootOps, "root-key")).created, false);
    await assert.rejects(() => make("different", [], [], "root-key"), expects("IDEMPOTENCY_CONFLICT"));
    assert.equal(await db.sourceChangesetEvent.count({ where: { changesetId: root.id } }), 1);
    assert.deepEqual((await getCanonicalSnapshot(repo.id, root.id, actor)).entries.map(x => x.path),
      ["assets/binary.bin", "docs/a.txt", "docs/empty"]);
    assert.equal((await getObject(repo.id, binary, actor)).dataBase64, encode(Buffer.from([0, 255, 1, 128])));
    await assert.rejects(() => getObject(repo.id, orphan, actor), expects("NOT_FOUND"));
    await assert.rejects(() => db.sourceChangeset.delete({ where: { id: root.id } }));
    await assert.rejects(() => db.sourceObject.update({ where: { id: alpha }, data: { byteSize: 8 } }));
  });

  await t.test("persistent root, integrity and bounded copy-on-write for single edit", async () => {
    const rootRecord = await db.sourceSnapshotRoot.findUniqueOrThrow({ where: { changesetId: root.id } });
    assert.equal(rootRecord.repositoryId, repo.id);
    const before = await db.sourceSnapshotNode.count();
    const edit = await make("bounded edit", [root.id],
      [{ kind: "MODIFY", path: "docs/a.txt", objectId: beta }]);
    const after = await db.sourceSnapshotNode.count();
    assert.ok(after - before <= 32, "a single small-path edit must not rewrite the full tree");
    const changed = await db.sourceSnapshotRoot.findUniqueOrThrow({ where: { changesetId: edit.id } });
    assert.notEqual(changed.rootId, rootRecord.rootId);
    assert.equal((await getCanonicalSnapshot(repo.id, root.id, actor)).entries.find(x => x.path === "docs/a.txt")?.objectId, alpha);
    assert.equal((await getCanonicalSnapshot(repo.id, edit.id, actor)).entries.find(x => x.path === "docs/a.txt")?.objectId, beta);
    // The preceding implementation validated the final state of ordered
    // operations. Temporary path overlap must remain legal when later resolved.
    const ordered = await make("ordered parent replacement", [root.id], [
      { kind: "ADD", path: "docs/a.txt/child", objectId: beta },
      { kind: "DELETE", path: "docs/a.txt" },
    ]);
    const orderedPaths = (await getCanonicalSnapshot(repo.id, ordered.id, actor)).entries.map(x => x.path);
    assert.ok(orderedPaths.includes("docs/a.txt/child"));
    assert.ok(!orderedPaths.includes("docs/a.txt"));
    const damaged = new SnapshotTree({ sourceSnapshotNode: {
      findUnique: async () => ({ data: Buffer.from("not a valid snapshot") }),
    } } as never);
    await assert.rejects(() => damaged.count(rootRecord.rootId), expects("CORRUPT_SNAPSHOT"));
    await assert.rejects(() => db.sourceSnapshotNode.update({
      where: { id: rootRecord.rootId }, data: { data: Buffer.from("tampered") },
    }));
  });

  const left = await make("left", [root.id], [{ kind: "MODIFY", path: "docs/a.txt", objectId: beta }]);
  const right = await make("right", [root.id], [{ kind: "ADD", path: "links/doc", objectId: symlink, mode: "120000" }]);
  const merge = await make("merge", [left.id, right.id], [
    { kind: "COPY", path: "docs/copy", previousPath: "docs/a.txt" },
    { kind: "RENAME", path: "docs/renamed", previousPath: "docs/a.txt" },
    { kind: "CHMOD", path: "assets/binary.bin", mode: "100644" },
    { kind: "DELETE", path: "docs/empty" },
  ]);
  await t.test("branching DAG, merge resolution, symlinks, executable bits and binary contents", async () => {
    const snapshot = await getCanonicalSnapshot(repo.id, merge.id, actor);
    assert.deepEqual(snapshot.entries.map(x => x.path), ["assets/binary.bin", "docs/copy", "docs/renamed"]);
    assert.equal(snapshot.entries.find(x => x.path === "docs/copy")?.objectId, beta);
    assert.equal(snapshot.entries.find(x => x.path === "assets/binary.bin")?.mode, "100644");
    assert.equal((await getCanonicalSnapshot(repo.id, right.id, actor)).entries.find(x => x.path === "links/doc")?.mode, "120000");
    assert.deepEqual((await getCanonicalChangeset(repo.id, merge.id, actor)).parents.map(x => x.parentId), [left.id, right.id]);
    assert.equal(await db.sourceReference.count({ where: { repositoryId: repo.id } }), 0);
    assert.equal((await listCanonicalEvents(repo.id, 30, actor)).length, 6);
  });

  await t.test("v2 delta changesets are queryable without client checkout", async () => {
    const ancestry = await ancestryQuery(repo.id, merge.id, right.id);
    assert.deepEqual(ancestry.mergeBases, [right.id]);
    const comparison = await compareQuery(repo.id, root.id, left.id);
    assert.ok(comparison.changes.some(item => item.path === "docs/a.txt" && item.kind === "MODIFY"));
    const tree = await treeQuery(repo.id, merge.id, "docs", 20);
    assert.deepEqual(tree.entries.map(item => item.path), ["docs/copy", "docs/renamed"]);
    const resolved = await resolvePath(repo.id, merge.id, "docs/renamed");
    assert.equal(resolved.objectId, beta);
    const history = await fileHistory(repo.id, merge.id, "docs/renamed");
    assert.deepEqual(history.records.map(row => row.changesetId), [merge.id, left.id, root.id]);
    const blame = await blameQuery(repo.id, merge.id, "docs/renamed");
    assert.equal(blame.lines[0].changesetId, left.id);
    const impact = await pathImpactQuery(repo.id, merge.id, "docs/a.txt");
    assert.ok(impact.records.some(row => row.changesetId === merge.id && row.role === "source"));
  });

  await t.test("reject object unavailability, unknown ancestors and invalid operations without publication", async () => {
    const before = await db.sourceChangeset.count({ where: { repositoryId: repo.id } });
    await assert.rejects(() => make("missing object", [root.id], [{ kind: "ADD", path: "x", objectId: "f".repeat(64) }]), expects("OBJECT_UNAVAILABLE"));
    await assert.rejects(() => make("unknown parent", ["f".repeat(64)], []), expects("UNKNOWN_PARENT"));
    await assert.rejects(() => make("duplicate parent", [root.id, root.id], []), expects("DUPLICATE_PARENT"));
    await assert.rejects(() => make("traversal", [root.id], [{ kind: "DELETE", path: "../escape" }]), expects("INVALID_INPUT"));
    await assert.rejects(() => make("missing", [root.id], [{ kind: "MODIFY", path: "absent", objectId: alpha }]), expects("MISSING_SOURCE"));
    await assert.rejects(() => make("file nesting", [root.id], [{ kind: "ADD", path: "docs/a.txt/child", objectId: alpha }]), expects("INVALID_PATH_GRAPH"));
    await assert.rejects(() => make("symlink chmod", [right.id], [{ kind: "CHMOD", path: "links/doc", mode: "100755" }]), expects("INVALID_MODE_CHANGE"));
    assert.equal(await db.sourceChangeset.count({ where: { repositoryId: repo.id } }), before);
  });

  await t.test("fault injection rolls back header, operations and event, then retry recovers", async () => {
    const trigger = "event_fail_" + suffix;
    const fn = "event_fn_" + suffix;
    await db.$executeRawUnsafe('CREATE FUNCTION "' + fn + '"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION \'injected event failure\'; END; $$');
    await db.$executeRawUnsafe('CREATE TRIGGER "' + trigger + '" BEFORE INSERT ON "SourceChangesetEvent" FOR EACH ROW WHEN (NEW."repositoryId" = \'' + repo.id + '\'::uuid) EXECUTE FUNCTION "' + fn + '"()');
    const count = await db.sourceChangeset.count({ where: { repositoryId: repo.id } });
    const events = await db.sourceChangesetEvent.count({ where: { repositoryId: repo.id } });
    const roots = await db.sourceSnapshotRoot.count({ where: { repositoryId: repo.id } });
    try {
      await assert.rejects(() => make("rollback candidate", [root.id], [{ kind: "ADD", path: "rollback", objectId: alpha }], "rollback"));
      assert.equal(await db.sourceChangeset.count({ where: { repositoryId: repo.id } }), count);
      assert.equal(await db.sourceChangesetEvent.count({ where: { repositoryId: repo.id } }), events);
      assert.equal(await db.sourceSnapshotRoot.count({ where: { repositoryId: repo.id } }), roots);
    } finally {
      await db.$executeRawUnsafe('DROP TRIGGER "' + trigger + '" ON "SourceChangesetEvent"');
      await db.$executeRawUnsafe('DROP FUNCTION "' + fn + '"()');
    }
    assert.equal((await make("rollback candidate", [root.id], [{ kind: "ADD", path: "rollback", objectId: alpha }], "rollback")).created, true);
  });

  await t.test("independent concurrent writers and duplicate racing requests", async () => {
    const requests = Array.from({ length: 10 }, (_, i) => make("independent " + i, [root.id],
      [{ kind: "ADD", path: "parallel/" + i, objectId: binary }]));
    const result = await Promise.all(requests);
    assert.equal(new Set(result.map(x => x.id)).size, 10);
    const duplicate = await Promise.all(Array.from({ length: 4 }, () => make("repeat", [root.id],
      [{ kind: "ADD", path: "same", objectId: alpha }], "racing")));
    assert.equal(new Set(duplicate.map(x => x.id)).size, 1);
    assert.equal(duplicate.filter(x => x.created).length, 1);
    assert.equal(await db.sourceChangesetEvent.count({ where: { changesetId: duplicate[0].id } }), 1);
  });

  await t.test("seeded property exploration checks branching deltas against independent file-state oracle", async () => {
    let seed = 1731;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
    type Entry = { objectId: string; mode: string };
    const starting = await getCanonicalSnapshot(repo.id, root.id, actor);
    const states = new Map<string, Map<string, Entry>>([[root.id, new Map(starting.entries.map(e =>
      [e.path, { objectId: e.objectId, mode: e.mode }]))]]);
    const history: string[] = [];
    for (let i = 0; i < 28; i++) {
      const parent = i < 2 ? root.id : history[random() % history.length];
      const state = new Map(states.get(parent)!);
      const names = [...state.keys()].sort();
      const candidate = "generated/" + i;
      const variant = random() % 6;
      const source = names.length ? names[random() % names.length] : undefined;
      let action: { kind: string; path: string; objectId?: string; previousPath?: string; mode?: string };
      if (!source || variant === 0) {
        const object = random() % 2 ? binary : empty;
        action = { kind: "ADD", path: candidate, objectId: object };
        state.set(candidate, { objectId: object, mode: "100644" });
      } else if (variant === 1) {
        const object = random() % 2 ? alpha : beta;
        action = { kind: "MODIFY", path: source, objectId: object };
        state.set(source, { objectId: object, mode: state.get(source)!.mode });
      } else if (variant === 2) {
        action = { kind: "RENAME", path: candidate, previousPath: source };
        state.set(candidate, state.get(source)!);
        state.delete(source);
      } else if (variant === 3) {
        action = { kind: "COPY", path: candidate, previousPath: source };
        state.set(candidate, state.get(source)!);
      } else if (variant === 4) {
        action = { kind: "DELETE", path: source };
        state.delete(source);
      } else {
        const next = state.get(source)!.mode === "100644" ? "100755" : "100644";
        action = { kind: "CHMOD", path: source, mode: next };
        state.set(source, { ...state.get(source)!, mode: next });
      }
      const created = await make("generated property " + i, [parent], [action]);
      history.push(created.id);
      states.set(created.id, state);
      const actual = (await getCanonicalSnapshot(repo.id, created.id, actor)).entries
        .map(e => [e.path, e.objectId, e.mode]);
      const expected = [...state.entries()].sort(([a], [b]) => a.localeCompare(b))
        .map(([path, entry]) => [path, entry.objectId, entry.mode]);
      assert.deepEqual(actual, expected, "seed " + seed + ", case " + i + ", operation " + action.kind);
      assert.equal((await getCanonicalChangeset(repo.id, created.id, actor)).treeId, null);
    }
  });

  await t.test("lazy migration of v1 trees without changing identity, bytes or ancestry", async () => {
    const legacy = await createChangeset(repo.id, actor, {
      apiVersion: 1, parents: [], message: "legacy tree", operations: [
        { kind: "PUT", path: "legacy/original.txt", dataBase64: encode("original v1 bytes"), fileMode: "100755" },
      ],
    });
    assert.ok(legacy.treeId);
    assert.equal(await db.sourceSnapshotRoot.count({ where: { changesetId: legacy.id } }), 0);
    const extended = await make("extend historical v1", [legacy.id], [
      { kind: "COPY", path: "legacy/copied.txt", previousPath: "legacy/original.txt" },
    ]);
    const migrated = await db.sourceSnapshotRoot.findUniqueOrThrow({ where: { changesetId: legacy.id } });
    assert.ok(migrated.rootId);
    const unchanged = await getCanonicalSnapshot(repo.id, legacy.id, actor);
    const current = await getCanonicalSnapshot(repo.id, extended.id, actor);
    assert.equal(unchanged.treeId, legacy.treeId);
    assert.deepEqual(unchanged.entries, [{ path: "legacy/original.txt",
      objectId: current.entries[1].objectId, mode: "100755" }]);
    assert.deepEqual(current.entries.map(x => x.path), ["legacy/copied.txt", "legacy/original.txt"]);
    assert.equal((await getCanonicalChangeset(repo.id, extended.id, actor)).parents[0].parentId, legacy.id);
    await assert.rejects(() => createCanonicalChangeset(foreign.id,
      { type: "AGENT", id: foreignAgent.id, credentialId: foreignCredential.id },
      { apiVersion: 2, parents: [legacy.id], description: "foreign history", operations: [] }),
      expects("UNKNOWN_PARENT"));
  });

  await t.test("HTTP authorization and new database client recovery", async () => {
    const uri = "http://localhost:3000/api/v2/repositories/" + repo.id;
    const params = { params: Promise.resolve({ id: repo.id }) };
    const payload = { apiVersion: 2, description: "HTTP", parents: [root.id], operations: [{ kind: "ADD", path: "http", objectId: alpha }] };
    const request = (secret: string) => new NextRequest(uri + "/changesets", { method: "POST",
      headers: { authorization: "Bearer " + secret, "content-type": "application/json" }, body: JSON.stringify(payload) });
    assert.equal((await publishApi(request(foreignToken), params)).status, 403);
    const response = await publishApi(request(token), params);
    assert.equal(response.status, 201);
    const made = await response.json();
    const read = await readApi(new NextRequest(uri + "/changesets/" + made.id, { headers: {
      authorization: "Bearer " + token,
    } }), { params: Promise.resolve({ id: repo.id, changesetId: made.id }) });
    assert.equal(read.status, 200);
    const oversized = await blobApi(new NextRequest(uri + "/objects", { method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ dataBase64: "A".repeat(6_100_000) }),
    }), params);
    assert.equal(oversized.status, 413);
    const uploaded = await blobApi(new NextRequest(uri + "/objects", { method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ dataBase64: encode("HTTP payload") }),
    }), params);
    assert.equal(uploaded.status, 201);
    await assert.rejects(() => createCanonicalChangeset(foreign.id, { type: "AGENT", id: foreignAgent.id, credentialId: foreignCredential.id },
      { apiVersion: 2, parents: [], description: "foreign read", operations: [
        { kind: "ADD", path: "private", objectId: alpha },
      ] }), expects("OBJECT_UNAVAILABLE"));
    const fresh = new PrismaClient();
    try {
      const stored = await fresh.sourceChangeset.findUniqueOrThrow({ where: { id: made.id }, include: { operations: true, parents: true } });
      assert.equal(stored.treeId, null);
      assert.equal(stored.operations.length, 1);
      assert.equal(stored.parents[0].parentId, root.id);
      assert.equal(await fresh.sourceChangesetEvent.count({ where: { changesetId: made.id } }), 1);
    } finally { await fresh.$disconnect(); }
  });

  // The v2 log is append-only. Tests require an isolated database and do not
  // delete canonical fixture records after publication.
  });
});

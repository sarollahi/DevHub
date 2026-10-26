import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { db } from "../src/lib/prisma";
import { tokenHash } from "../src/lib/auth";
import { createChangeset, getChangeset, getObject, getTree, approveChangeset, advanceReference } from "../src/source-control/service";
import { SourceControlError } from "../src/source-control/contracts";
import { objectId, encodeTree } from "../src/source-control/storage";
import { POST as postChangeset, GET as listChangesets } from "../src/app/api/v1/repositories/[id]/changesets/route";
import { PUT as putReference } from "../src/app/api/v1/repositories/[id]/refs/[...name]/route";
import { POST as postApproval } from "../src/app/api/v1/repositories/[id]/changesets/[changesetId]/approve/route";

test("native source control against real PostgreSQL, with immutable branchless history and owner authorization", { timeout: 60000 }, async (t) => {
  const suffix = randomBytes(7).toString("hex");
  const user = await db.user.create({ data: { handle: `native-${suffix}`, email: `native-${suffix}@example.invalid` } });
  const outsider = await db.user.create({ data: { handle: `other-${suffix}`, email: `other-${suffix}@example.invalid` } });
  const repo = await db.repository.create({ data: { ownerId: user.id, name: "Native Repository", slug: "native", requireHumanApproval: true } });
  const otherRepo = await db.repository.create({ data: { ownerId: outsider.id, name: "Foreign Repository", slug: "foreign" } });
  const agent = await db.agentIdentity.create({ data: { ownerId: user.id, name: "writer", scopes: ["changesets:write", "changesets:read"] } });
  const foreignAgent = await db.agentIdentity.create({ data: { ownerId: outsider.id, name: "writer", scopes: ["changesets:write"] } });
  const secret = randomBytes(32).toString("hex");
  const foreignSecret = randomBytes(32).toString("hex");
  await db.agentCredential.createMany({ data: [
    { agentId: agent.id, tokenHash: tokenHash(secret), label: "test" },
    { agentId: foreignAgent.id, tokenHash: tokenHash(foreignSecret), label: "foreign" },
  ] });
  const ids: string[] = [];
  const blobs: string[] = [];
  const rootUri = `http://localhost:3000/api/v1/repositories/${repo.id}`;
  const routes = { params: Promise.resolve({ id: repo.id }) };
  const ownerToken = process.env.ADMIN_TOKEN!;
  const headers = { authorization: `Bearer ${secret}`, "content-type": "application/json" };
  const adminHeaders = { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" };
  const dataBase64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
  const firstInput = { apiVersion: 1 as const, parents: [], message: "Initial immutable document",
    operations: [{ kind: "PUT" as const, path: "docs/intro.md", dataBase64: dataBase64("hello native storage") }] };
  const actor = { id: agent.id, type: "AGENT" as const };
  const inserted = async (body: unknown) => {
    const receipt = await createChangeset(repo.id, actor, body);
    ids.push(receipt.id);
    return receipt;
  };

  t.after(async () => {
    await db.sourceReference.deleteMany({ where: { repositoryId: { in: [repo.id, otherRepo.id] } } });
    await db.sourceChangeApproval.deleteMany({ where: { changesetId: { in: ids } } });
    await db.sourceValidation.deleteMany({ where: { changesetId: { in: ids } } });
    await db.sourceFileOperation.deleteMany({ where: { changesetId: { in: ids } } });
    await db.sourceChangesetParent.deleteMany({ where: { OR: [{ changesetId: { in: ids } }, { parentId: { in: ids } }] } });
    await db.sourceChangeset.deleteMany({ where: { id: { in: ids } } });
    await db.sourceObject.deleteMany({ where: { id: { in: blobs } } });
    await db.auditEvent.deleteMany({ where: { repositoryId: { in: [repo.id, otherRepo.id] } } });
    await db.agentIdentity.deleteMany({ where: { ownerId: { in: [user.id, outsider.id] } } });
    await db.repository.deleteMany({ where: { id: { in: [repo.id, otherRepo.id] } } });
    await db.user.deleteMany({ where: { id: { in: [user.id, outsider.id] } } });
  });

  let first = await inserted(firstInput);
  blobs.push(first.treeId, objectId("BLOB", Buffer.from("hello native storage")));

  await t.test("content-addressed objects and deterministic branchless replay", async () => {
    assert.equal(first.created, true);
    assert.match(first.id, /^[a-f0-9]{64}$/);
    assert.equal(first.treeId, objectId("TREE", encodeTree([{ path: "docs/intro.md", objectId: blobs[1] }])));
    assert.deepEqual((await getTree(repo.id, first.id)).entries, [{ path: "docs/intro.md", objectId: blobs[1] }]);
    assert.equal((await getObject(repo.id, blobs[1])).dataBase64, dataBase64("hello native storage"));
    assert.equal((await inserted(firstInput)).created, false);
    assert.equal(await db.sourceChangeset.count({ where: { repositoryId: repo.id } }), 1);
    assert.equal(await db.sourceReference.count({ where: { repositoryId: repo.id } }), 0);
    const snapshot = await getChangeset(repo.id, first.id);
    assert.equal(snapshot?.validation?.state, "SUCCESS");
    assert.equal(snapshot?.operations.length, 1);
  });

  await t.test("versioned HTTP API rejects foreign agents and stores real data", async () => {
    const req = (token: string) => new NextRequest(`${rootUri}/changesets`, { method: "POST", headers: {
      authorization: `Bearer ${token}`, "content-type": "application/json",
    }, body: JSON.stringify({ ...firstInput, message: "From HTTP agent" }) });
    assert.equal((await postChangeset(req(foreignSecret), routes)).status, 403);
    const made = await postChangeset(req(secret), routes);
    assert.equal(made.status, 201);
    const json = await made.json();
    ids.push(json.id); blobs.push(json.treeId);
    const read = await listChangesets(new NextRequest(`${rootUri}/changesets`, { headers }), routes);
    assert.equal(read.status, 200);
    assert.equal((await read.json()).records.length, 2);
    assert.equal((await listChangesets(new NextRequest(`${rootUri}/changesets`, { headers: {
      authorization: `Bearer ${foreignSecret}`,
    } }), routes)).status, 403);
    await assert.rejects(() => getObject(otherRepo.id, blobs[1]), (e: unknown) => e instanceof SourceControlError && e.status === 404);
  });

  const updatedInput = { apiVersion: 1 as const, parents: [first.id], message: "Move and edit history",
    operations: [
      { kind: "MOVE" as const, path: "docs/moved.md", previousPath: "docs/intro.md" },
      { kind: "PUT" as const, path: "src/entry.ts", dataBase64: dataBase64("export const value = 7;") },
    ] };
  const updated = await inserted(updatedInput);
  blobs.push(updated.treeId, objectId("BLOB", Buffer.from("export const value = 7;")));

  await t.test("parent chains, file operations and tree state are persisted correctly", async () => {
    const child = await getChangeset(repo.id, updated.id);
    assert.deepEqual(child?.parents.map(p => p.parentId), [first.id]);
    assert.deepEqual((await getTree(repo.id, updated.id)).entries.map(x => x.path), ["docs/moved.md", "src/entry.ts"]);
    assert.equal(child?.operations.find(o => o.path === "docs/moved.md")?.previousPath, "docs/intro.md");
    assert.equal(await db.sourceReference.count({ where: { repositoryId: repo.id } }), 0);
    await assert.rejects(() => inserted({ ...updatedInput, parents: ["f".repeat(64)] }),
      (e: unknown) => e instanceof SourceControlError && e.code === "UNKNOWN_PARENT");
    await assert.rejects(() => inserted({ ...updatedInput, operations: [{ kind: "DELETE", path: "../escape" }] }),
      (e: unknown) => e instanceof SourceControlError && e.code === "INVALID_INPUT");
  });

  await t.test("database enforces immutability of both objects and committed changesets", async () => {
    await assert.rejects(() => db.sourceObject.update({ where: { id: first.treeId }, data: { byteSize: 1 } }));
    await assert.rejects(() => db.sourceChangeset.update({ where: { id: first.id }, data: { message: "tamper" } }));
    assert.equal((await getChangeset(repo.id, first.id))?.message, firstInput.message);
    assert.equal((await getTree(repo.id, first.id)).entries.length, 1);
  });

  await t.test("human approval gates reference creation and CAS conflict detection", async () => {
    await assert.rejects(() => advanceReference(repo.id, "main", first.id, null, user.id),
      (e: unknown) => e instanceof SourceControlError && e.code === "HUMAN_APPROVAL_REQUIRED");
    assert.equal((await putReference(new NextRequest(`${rootUri}/refs/main`, {
      method: "PUT", headers, body: JSON.stringify({ changesetId: first.id, expectedGeneration: null }),
    }), { params: Promise.resolve({ id: repo.id, name: ["main"] }) })).status, 401);
    assert.equal((await postApproval(new NextRequest(`${rootUri}/changesets/${first.id}/approve`, {
      method: "POST", headers,
    }), { params: Promise.resolve({ id: repo.id, changesetId: first.id }) })).status, 401);
    const approval = await postApproval(new NextRequest(`${rootUri}/changesets/${first.id}/approve`, {
      method: "POST", headers: adminHeaders,
    }), { params: Promise.resolve({ id: repo.id, changesetId: first.id }) });
    assert.equal(approval.status, 200);
    const ref = await advanceReference(repo.id, "main", first.id, null, user.id);
    assert.equal(ref.generation, 1);
    await assert.rejects(() => advanceReference(repo.id, "main", first.id, null, user.id),
      (e: unknown) => e instanceof SourceControlError && e.code === "REFERENCE_CONFLICT");
    await assert.rejects(() => advanceReference(repo.id, "main", updated.id, 1, user.id),
      (e: unknown) => e instanceof SourceControlError && e.code === "HUMAN_APPROVAL_REQUIRED");
    await approveChangeset(repo.id, updated.id, user.id);
    const next = await advanceReference(repo.id, "main", updated.id, 1, user.id);
    assert.equal(next.generation, 2);
    assert.equal(next.changesetId, updated.id);
    await assert.rejects(() => advanceReference(repo.id, "main", first.id, 1, user.id),
      (e: unknown) => e instanceof SourceControlError && e.code === "REFERENCE_CONFLICT");
    assert.equal((await db.sourceReference.findUniqueOrThrow({ where: { repositoryId_name: {
      repositoryId: repo.id, name: "main",
    } } })).changesetId, updated.id);
  });

  await t.test("concurrent branchless submissions require no repository ref or global lock", async () => {
    const inputs = Array.from({ length: 5 }, (_, n) => ({
      apiVersion: 1 as const, parents: [updated.id], message: `Independent candidate ${n}`,
      operations: [{ kind: "PUT" as const, path: `candidate/${n}.txt`, dataBase64: dataBase64(`candidate ${n}`) }],
    }));
    const results = await Promise.all(inputs.map(input => inserted(input)));
    assert.equal(new Set(results.map(x => x.id)).size, 5);
    for (let n = 0; n < results.length; n++) {
      blobs.push(results[n].treeId, objectId("BLOB", Buffer.from(`candidate ${n}`)));
      assert.equal((await getChangeset(repo.id, results[n].id))?.parents[0].parentId, updated.id);
    }
    assert.equal(await db.sourceReference.count({ where: { repositoryId: repo.id } }), 1);
    const pair = await Promise.allSettled([
      advanceReference(repo.id, "main", results[0].id, 2, user.id),
      advanceReference(repo.id, "main", results[1].id, 2, user.id),
    ]);
    assert.ok(pair.every(p => p.status === "rejected"), "Unapproved candidates cannot advance a reference");
  });
});

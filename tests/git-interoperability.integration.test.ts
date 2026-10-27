import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm, readFile, writeFile, chmod, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { request as httpRequest } from "node:http";
import { promisify } from "node:util";
import { db } from "../src/lib/prisma";
import { stageCanonicalBlob, createCanonicalChangeset } from "../src/source-control/canonical";
import { mutateReference } from "../src/source-control/refs";
import { gitCacheDirectory, syncGitProjection } from "../src/source-control/git-interoperability";
import { createGitGateway } from "../src/source-control/git-gateway";

const runFile = promisify(execFile);
async function git(cwd: string, ...args: string[]) {
  const { stdout } = await runFile("git", ["-C", cwd, ...args], {
    timeout: 90000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Interop Developer", GIT_AUTHOR_EMAIL: "developer@example.test",
      GIT_COMMITTER_NAME: "Interop Developer", GIT_COMMITTER_EMAIL: "developer@example.test" },
  });
  return stdout.trim();
}
async function listen(server: ReturnType<typeof createGitGateway>) {
  await new Promise<void>((yes, no) => server.listen(0, "127.0.0.1", yes).once("error", no));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  return address.port;
}
async function close(server: ReturnType<typeof createGitGateway>) {
  await new Promise<void>(yes => server.close(() => yes()));
}

test("native binary/modes/ancestry round-trip over Git smart HTTP with fail-closed push", {
  timeout: 180_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "devhub-git-interop-"));
  const prevRoot = process.env.GIT_INTEROP_ROOT;
  const prevTls = process.env.GIT_INTEROP_ALLOW_INSECURE_LOCALHOST;
  let server: ReturnType<typeof createGitGateway> | undefined;
  try {
    process.env.GIT_INTEROP_ROOT = root;
    process.env.GIT_INTEROP_ALLOW_INSECURE_LOCALHOST = "1";
    const suffix = randomBytes(6).toString("hex");
    const user = await db.user.create({ data: { handle: "gitsync-" + suffix,
      email: "gitsync-" + suffix + "@example.test" } });
    const repository = await db.repository.create({ data: { ownerId: user.id,
      slug: "gitsync-" + suffix, name: "Git interoperability", defaultBranch: "protected-main",
      requireHumanApproval: false } });
    const session = await db.humanSession.create({ data: { userId: user.id,
      tokenHash: randomBytes(32).toString("hex"), expiresAt: new Date(Date.now() + 3600000) } });
    const actor = { type: "HUMAN" as const, id: user.id, sessionId: session.id };
    const original = Buffer.from([0, 255, 12, 0, 0, 1, 2, 250]);
    const binary = await stageCanonicalBlob(repository.id, actor, original.toString("base64"));
    const executable = await stageCanonicalBlob(repository.id, actor, Buffer.from("#!/bin/sh\necho OK\n").toString("base64"));
    const link = await stageCanonicalBlob(repository.id, actor, Buffer.from("run.sh").toString("base64"));
    const source = await createCanonicalChangeset(repository.id, actor, {
      apiVersion: 2, parents: [], description: "Original binary and file modes",
      operations: [
        { kind: "ADD", path: "data.bin", objectId: binary.id },
        { kind: "ADD", path: "run.sh", objectId: executable.id, mode: "100755" },
        { kind: "ADD", path: "alias.sh", objectId: link.id, mode: "120000" },
      ],
    });
    await mutateReference(repository.id, actor, { name: "dev", kind: "BRANCH",
      operation: "CREATE", mutationId: "test-git-interop-create", expectedGeneration: null,
      changesetId: source.id });
    const cache = await gitCacheDirectory(repository.id);
    await syncGitProjection(repository.id, actor, cache);
    const first = await db.gitInteropCommit.findUniqueOrThrow({ where: {
      repositoryId_changesetId: { repositoryId: repository.id, changesetId: source.id },
    } });
    await syncGitProjection(repository.id, actor, cache);
    const second = await db.gitInteropCommit.findUniqueOrThrow({ where: {
      repositoryId_changesetId: { repositoryId: repository.id, changesetId: source.id },
    } });
    assert.equal(first.gitSha, second.gitSha, "incremental export must retain identities");
    const token = "dvg_" + randomBytes(32).toString("base64url");
    await db.gitInteropCredential.create({ data: { repositoryId: repository.id, userId: user.id,
      tokenHash: createHash("sha256").update(token).digest("hex"),
      scopes: ["source:read", "changeset:write", "ref:update", "admin"],
      expiresAt: new Date(Date.now() + 3600000) } });
    server = createGitGateway();
    const port = await listen(server);
    const header = "Authorization: Basic " + Buffer.from("git:" + token).toString("base64");
    const clone = join(root, "checkout");
    const remote = `http://127.0.0.1:${port}/git/${repository.id}.git`;
    await git(root, "-c", "http.extraHeader=" + header, "clone", "--branch", "dev", remote, clone);
    assert.deepEqual(await readFile(join(clone, "data.bin")), original);
    assert.ok(((await stat(join(clone, "run.sh"))).mode & 0o111) !== 0);
    const readAlias = await readFile(join(clone, "alias.sh"), "utf8");
    assert.match(readAlias, /echo OK/); // symlink resolves to the executable script
    await writeFile(join(clone, "next.txt"), Buffer.from("Pushed through Git\n"));
    await git(clone, "add", "next.txt");
    await git(clone, "commit", "-m", "Git client update");
    const pushedSha = await git(clone, "rev-parse", "HEAD");
    await git(clone, "-c", "http.extraHeader=" + header, "push", "origin", "HEAD:dev");
    const updated = await db.sourceReference.findUniqueOrThrow({ where: {
      repositoryId_name: { repositoryId: repository.id, name: "dev" },
    } });
    assert.notEqual(updated.changesetId, source.id);
    const imported = await db.gitImportCommit.findUniqueOrThrow({ where: {
      repositoryId_gitSha: { repositoryId: repository.id, gitSha: pushedSha },
    } });
    assert.equal(imported.changesetId, updated.changesetId);
    await syncGitProjection(repository.id, actor, cache);
    assert.equal((await git(cache, "rev-parse", "refs/heads/dev")), pushedSha,
      "native ref re-export must not rewrite an accepted Git push");

    // A two-parent Git merge must preserve parent order and materialized tree.
    await git(clone, "checkout", "-b", "merge-side");
    await writeFile(join(clone, "side.txt"), "merged from side\n");
    await git(clone, "add", "side.txt");
    await git(clone, "commit", "-m", "Side branch");
    const sideSha = await git(clone, "rev-parse", "HEAD");
    await git(clone, "checkout", "dev");
    await writeFile(join(clone, "main.txt"), "merged from main\n");
    await git(clone, "add", "main.txt");
    await git(clone, "commit", "-m", "Main branch");
    const mainSha = await git(clone, "rev-parse", "HEAD");
    await git(clone, "merge", "--no-ff", "merge-side", "-m", "Ordered merge");
    const mergeSha = await git(clone, "rev-parse", "HEAD");
    await git(clone, "-c", "http.extraHeader=" + header, "push", "origin", "HEAD:dev");
    const merged = await db.gitImportCommit.findUniqueOrThrow({ where: {
      repositoryId_gitSha: { repositoryId: repository.id, gitSha: mergeSha },
    } });
    const parentRows = await db.sourceChangesetParent.findMany({
      where: { changesetId: merged.changesetId }, orderBy: { position: "asc" },
    });
    const [main, side] = await Promise.all([mainSha, sideSha].map(sha =>
      db.gitImportCommit.findUniqueOrThrow({ where: {
        repositoryId_gitSha: { repositoryId: repository.id, gitSha: sha },
      } })));
    assert.deepEqual(parentRows.map(x => x.parentId), [main.changesetId, side.changesetId]);
    await syncGitProjection(repository.id, actor, cache);
    assert.equal(await git(cache, "rev-parse", "refs/heads/dev"), mergeSha);
    await git(clone, "tag", "v1.0.0");
    await git(clone, "-c", "http.extraHeader=" + header, "push", "origin", "refs/tags/v1.0.0");
    assert.equal((await db.sourceReference.findUniqueOrThrow({ where: {
      repositoryId_name: { repositoryId: repository.id, name: "tags/v1.0.0" },
    } })).changesetId, merged.changesetId);

    // One --atomic push publishes both a branch and a tag as one native transaction.
    await git(clone, "checkout", "-b", "batch-branch");
    await git(clone, "commit", "--allow-empty", "-m", "Atomic multi-ref Git push");
    const batchSha = await git(clone, "rev-parse", "HEAD");
    await git(clone, "tag", "v2.0.0");
    await git(clone, "-c", "http.extraHeader=" + header, "push", "--atomic", "origin",
      "HEAD:refs/heads/batch-branch", "refs/tags/v2.0.0");
    const [batchBranch, batchTag] = await Promise.all(["batch-branch", "tags/v2.0.0"].map(name =>
      db.sourceReference.findUniqueOrThrow({ where: {
        repositoryId_name: { repositoryId: repository.id, name },
      } })));
    assert.equal(batchBranch.changesetId, batchTag.changesetId);
    assert.equal((await db.gitInteropCommit.findUniqueOrThrow({ where: {
      repositoryId_gitSha: { repositoryId: repository.id, gitSha: batchSha },
    } })).changesetId, batchBranch.changesetId);

    // The entire native batch fails if a tag is being rewritten.
    await git(clone, "tag", "-f", "v2.0.0", "HEAD~1");
    await assert.rejects(() => git(clone, "-c", "http.extraHeader=" + header, "push",
      "--atomic", "--force", "origin", "HEAD:refs/heads/unpublished", "refs/tags/v2.0.0"),
      /rejected|failed|hook declined/i);
    assert.equal(await db.sourceReference.findUnique({ where: {
      repositoryId_name: { repositoryId: repository.id, name: "unpublished" },
    } }), null);

    // Deletion is persisted as a native tombstone, not an independent Git state.
    await git(clone, "-c", "http.extraHeader=" + header, "push", "origin", ":refs/heads/batch-branch");
    assert.ok((await db.sourceReference.findUniqueOrThrow({ where: {
      repositoryId_name: { repositoryId: repository.id, name: "batch-branch" },
    } })).deletedAt);

    // Non-fast-forward updates require a scoped admin token, explicit old-SHA
    // lease, an audited reason, and opt-in native reference policy.
    await git(clone, "checkout", "dev");
    await git(clone, "checkout", "-b", "rewritable");
    await git(clone, "commit", "--allow-empty", "-m", "Before rewrite");
    await git(clone, "-c", "http.extraHeader=" + header, "push", "origin", "HEAD:rewritable");
    const leaseSha = await git(clone, "rev-parse", "HEAD");
    await db.sourceReferencePolicy.create({ data: {
      repositoryId: repository.id, name: "rewritable", protected: false, allowForce: true,
    } });
    await git(clone, "reset", "--hard", "HEAD~1");
    await git(clone, "commit", "--allow-empty", "-m", "Rewritten history");
    const rewrittenSha = await git(clone, "rev-parse", "HEAD");
    await assert.rejects(() => git(clone, "-c", "http.extraHeader=" + header,
      "push", "--force-with-lease=refs/heads/rewritable:" + leaseSha,
      "origin", "HEAD:rewritable"), /rejected|failed|hook declined/i);
    await git(clone, "-c", "http.extraHeader=" + header, "push",
      "--force-with-lease=refs/heads/rewritable:" + leaseSha,
      "-o", "devhub-force-reason=Reviewed replacement for invalid history",
      "-o", "devhub-lease=refs/heads/rewritable:" + leaseSha,
      "origin", "HEAD:rewritable");
    const rewritten = await db.sourceReference.findUniqueOrThrow({ where: {
      repositoryId_name: { repositoryId: repository.id, name: "rewritable" },
    } });
    assert.equal(rewritten.changesetId, (await db.gitInteropCommit.findUniqueOrThrow({
      where: { repositoryId_gitSha: { repositoryId: repository.id, gitSha: rewrittenSha } },
    })).changesetId);
    const forceAudit = await db.sourceRefMutation.findFirstOrThrow({ where: {
      repositoryId: repository.id, name: "rewritable", operation: "UPDATE" },
      orderBy: { createdAt: "desc" },
    });
    assert.equal(forceAudit.forced, true);
    assert.match(forceAudit.reason ?? "", /Reviewed replacement/);

    await git(clone, "checkout", "dev");
    await writeFile(join(clone, "protected.txt"), "cannot create protected main with direct push");
    await git(clone, "add", "protected.txt");
    await git(clone, "commit", "-m", "Protected branch attempt");
    await assert.rejects(() => git(clone, "-c", "http.extraHeader=" + header, "push", "origin",
      "HEAD:protected-main"), /rejected|failed|hook declined/i);
    assert.equal(await db.sourceReference.findUnique({ where: {
      repositoryId_name: { repositoryId: repository.id, name: "protected-main" },
    } }), null);
    // Native concurrent advancement must invalidate a stale Git writer.
    const latest = await db.sourceReference.findUniqueOrThrow({ where: {
      repositoryId_name: { repositoryId: repository.id, name: "dev" },
    } });
    const newerBlob = await stageCanonicalBlob(repository.id, actor, Buffer.from("native\n").toString("base64"));
    const newer = await createCanonicalChangeset(repository.id, actor, {
      apiVersion: 2, parents: [latest.changesetId], description: "Concurrent native change",
      operations: [{ kind: "ADD", path: "from-native.txt", objectId: newerBlob.id }],
    });
    await mutateReference(repository.id, actor, { name: "dev", kind: "BRANCH", operation: "UPDATE",
      changesetId: newer.id, expectedGeneration: latest.generation, expectedChangesetId: latest.changesetId,
      mutationId: "test-git-interop-native-race" });
    await assert.rejects(() => git(clone, "-c", "http.extraHeader=" + header, "push", "origin", "HEAD:dev"),
      /rejected|fetch first|non-fast-forward|failed/i);
    const final = await db.sourceReference.findUniqueOrThrow({ where: {
      repositoryId_name: { repositoryId: repository.id, name: "dev" },
    } });
    assert.equal(final.changesetId, newer.id);
    // A truncated upload must not acquire a native ref update.
    await new Promise<void>(resolve => {
      const request = httpRequest(remote + "/git-receive-pack", {
        method: "POST", headers: { Authorization: "Basic " + Buffer.from("git:" + token).toString("base64"),
          "Content-Type": "application/x-git-receive-pack-request", "Transfer-Encoding": "chunked" },
      }, response => { response.resume(); response.on("end", resolve); });
      request.once("error", () => resolve());
      request.once("close", resolve);
      request.flushHeaders();
      request.write(Buffer.alloc(64 * 1024, 0x61));
      // A real interrupted request: close mid-pack with no terminating pkt-line.
      setImmediate(() => request.destroy());
    });
    assert.equal((await db.sourceReference.findUniqueOrThrow({ where: {
      repositoryId_name: { repositoryId: repository.id, name: "dev" },
    } })).changesetId, newer.id);

    // Git fetch must see a native commit without rewriting its native ancestry.
    await git(clone, "-c", "http.extraHeader=" + header, "fetch", "origin");
    assert.equal(await git(clone, "rev-parse", "refs/remotes/origin/dev"),
      (await db.gitInteropCommit.findUniqueOrThrow({ where: {
        repositoryId_changesetId: { repositoryId: repository.id, changesetId: newer.id },
      } })).gitSha);
    await git(clone, "reset", "--hard", "refs/remotes/origin/dev");
    assert.equal(await readFile(join(clone, "from-native.txt"), "utf8"), "native\n");

    // Revoked tokens fail closed even when the caller holds stale Git pack objects.
    const credential = await db.gitInteropCredential.findUniqueOrThrow({ where: {
      tokenHash: createHash("sha256").update(token).digest("hex"),
    } });
    await db.gitInteropCredential.update({ where: { id: credential.id },
      data: { revokedAt: new Date() } });
    await assert.rejects(() => git(clone, "-c", "http.extraHeader=" + header, "fetch", "origin"),
      /Authentication failed|401|fatal:|could not read Username|requested URL returned error/i);
  } finally {
    if (server) await close(server);
    if (prevRoot === undefined) delete process.env.GIT_INTEROP_ROOT;
    else process.env.GIT_INTEROP_ROOT = prevRoot;
    if (prevTls === undefined) delete process.env.GIT_INTEROP_ALLOW_INSECURE_LOCALHOST;
    else process.env.GIT_INTEROP_ALLOW_INSECURE_LOCALHOST = prevTls;
    await rm(root, { recursive: true, force: true });
  }
});

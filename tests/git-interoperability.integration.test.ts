import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm, readFile, writeFile, chmod, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
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
      scopes: ["source:read", "changeset:write", "ref:update"],
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
    await writeFile(join(clone, "protected.txt"), "cannot create protected main with direct push");
    await git(clone, "add", "protected.txt");
    await git(clone, "commit", "-m", "Protected branch attempt");
    await assert.rejects(() => git(clone, "-c", "http.extraHeader=" + header, "push", "origin",
      "HEAD:protected-main"), /rejected|failed|hook declined/i);
    assert.equal(await db.sourceReference.findUnique({ where: {
      repositoryId_name: { repositoryId: repository.id, name: "protected-main" },
    } }), null);
    // Native concurrent advancement must invalidate a stale Git writer.
    const newerBlob = await stageCanonicalBlob(repository.id, actor, Buffer.from("native\n").toString("base64"));
    const newer = await createCanonicalChangeset(repository.id, actor, {
      apiVersion: 2, parents: [updated.changesetId], description: "Concurrent native change",
      operations: [{ kind: "ADD", path: "from-native.txt", objectId: newerBlob.id }],
    });
    await mutateReference(repository.id, actor, { name: "dev", kind: "BRANCH", operation: "UPDATE",
      changesetId: newer.id, expectedGeneration: updated.generation, expectedChangesetId: updated.changesetId,
      mutationId: "test-git-interop-native-race" });
    await assert.rejects(() => git(clone, "-c", "http.extraHeader=" + header, "push", "origin", "HEAD:dev"),
      /rejected|fetch first|non-fast-forward|failed/i);
    const final = await db.sourceReference.findUniqueOrThrow({ where: {
      repositoryId_name: { repositoryId: repository.id, name: "dev" },
    } });
    assert.equal(final.changesetId, newer.id);
  } finally {
    if (server) await close(server);
    if (prevRoot === undefined) delete process.env.GIT_INTEROP_ROOT;
    else process.env.GIT_INTEROP_ROOT = prevRoot;
    if (prevTls === undefined) delete process.env.GIT_INTEROP_ALLOW_INSECURE_LOCALHOST;
    else process.env.GIT_INTEROP_ALLOW_INSECURE_LOCALHOST = prevTls;
    await rm(root, { recursive: true, force: true });
  }
});

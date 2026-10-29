import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createServer, connect } from "node:net";
import { promisify } from "node:util";
import { db } from "../src/lib/prisma";
import { stageCanonicalBlob, createCanonicalChangeset } from "../src/source-control/canonical";
import { mutateReference } from "../src/source-control/refs";

const execAsync = promisify(execFile);
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function freePort() {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Expected TCP port");
  const port = address.port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}
async function awaitPort(port: number, child: ChildProcess) {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw Error("Git gateway exited before readiness");
    const online = await new Promise<boolean>(resolve => {
      const socket = connect(port, "127.0.0.1");
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false));
      socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
    });
    if (online) return;
    await sleep(100);
  }
  throw Error("Git gateway did not listen");
}
async function git(cwd: string, ...args: string[]) {
  const { stdout } = await execAsync("git", ["-C", cwd, ...args], {
    timeout: 90_000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Distributed Test", GIT_AUTHOR_EMAIL: "distributed@example.test",
      GIT_COMMITTER_NAME: "Distributed Test", GIT_COMMITTER_EMAIL: "distributed@example.test" },
  });
  return stdout.trim();
}

test("two independently forked Git gateway processes reject one stale concurrent push", {
  timeout: 180_000,
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "devhub-git-replicas-"));
  const children: ChildProcess[] = [];
  try {
    const suffix = randomBytes(6).toString("hex");
    const user = await db.user.create({ data: {
      handle: "replica-" + suffix, email: "replica-" + suffix + "@example.test",
    } });
    const repo = await db.repository.create({ data: {
      ownerId: user.id, slug: "replica-" + suffix, name: "Git replica test",
      defaultBranch: "main", requireHumanApproval: false,
    } });
    const session = await db.humanSession.create({ data: {
      userId: user.id, tokenHash: randomBytes(32).toString("hex"),
      expiresAt: new Date(Date.now() + 3_600_000),
    } });
    const actor = { type: "HUMAN" as const, id: user.id, sessionId: session.id };
    const blob = await stageCanonicalBlob(repo.id, actor, Buffer.from("base\n").toString("base64"));
    const base = await createCanonicalChangeset(repo.id, actor, {
      apiVersion: 2, parents: [], description: "Base revision",
      operations: [{ kind: "ADD", path: "README.txt", objectId: blob.id }],
    });
    await mutateReference(repo.id, actor, {
      name: "dev", kind: "BRANCH", operation: "CREATE",
      mutationId: "distributed-git-base-" + suffix,
      expectedGeneration: null, changesetId: base.id,
    });
    const token = "dvg_" + randomBytes(32).toString("base64url");
    await db.gitInteropCredential.create({ data: {
      repositoryId: repo.id, userId: user.id,
      tokenHash: createHash("sha256").update(token).digest("hex"),
      scopes: ["source:read", "changeset:write", "ref:update", "admin"],
      expiresAt: new Date(Date.now() + 3_600_000),
    } });
    const authorization = "Authorization: Basic " + Buffer.from("git:" + token).toString("base64");
    const ports = await Promise.all([freePort(), freePort()]);
    for (let i = 0; i < 2; i++) {
      const child = spawn(process.execPath, ["--import", "tsx", "scripts/git-interop-server.ts"], {
        cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, GIT_INTEROP_ROOT: join(root, "gateway-" + i),
          GIT_INTEROP_HOST: "127.0.0.1", GIT_INTEROP_PORT: String(ports[i]),
          GIT_INTEROP_ALLOW_INSECURE_LOCALHOST: "1" },
      });
      children.push(child);
      await awaitPort(ports[i], child);
    }
    const checkouts = [join(root, "checkout-a"), join(root, "checkout-b")];
    for (let i = 0; i < 2; i++) {
      await git(root, "-c", "http.extraHeader=" + authorization, "clone",
        "--branch", "dev", "http://127.0.0.1:" + ports[i] + "/git/" + repo.id + ".git",
        checkouts[i]);
      await writeFile(join(checkouts[i], "change-" + i + ".txt"), "replica-" + i + "\n");
      await git(checkouts[i], "add", ".");
      await git(checkouts[i], "commit", "-m", "Independent update " + i);
    }
    const proposed = await Promise.all(checkouts.map(dir => git(dir, "rev-parse", "HEAD")));
    const results = await Promise.allSettled(checkouts.map(dir =>
      git(dir, "-c", "http.extraHeader=" + authorization, "push", "origin", "HEAD:dev")));
    const successCount = results.filter(x => x.status === "fulfilled").length;
    assert.equal(successCount, 1, "one of two concurrent independent gateways must reject a stale ref");
    const winner = results.findIndex(x => x.status === "fulfilled");
    const live = await db.sourceReference.findUniqueOrThrow({
      where: { repositoryId_name: { repositoryId: repo.id, name: "dev" } },
    });
    assert.notEqual(live.changesetId, base.id);
    const imported = await db.gitImportCommit.findUniqueOrThrow({
      where: { repositoryId_gitSha: { repositoryId: repo.id, gitSha: proposed[winner] } },
    });
    assert.equal(live.changesetId, imported.changesetId);
    assert.equal(await db.sourceRefMutation.count({ where: {
      repositoryId: repo.id, name: "dev",
    } }), 2, "create + exactly one successful push in authoritative journal");
    // The failed gateway cache is disposable: subsequent fetch repairs it.
    const failed = winner === 0 ? 1 : 0;
    await git(checkouts[failed], "-c", "http.extraHeader=" + authorization,
      "fetch", "origin");
    assert.equal(await git(checkouts[failed], "rev-parse", "refs/remotes/origin/dev"),
      proposed[winner]);
  } finally {
    for (const child of children) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise(resolve => child.once("exit", resolve)),
        sleep(3000).then(() => { if (child.exitCode === null) child.kill("SIGKILL"); }),
      ]);
    }
    await rm(root, { recursive: true, force: true });
  }
});

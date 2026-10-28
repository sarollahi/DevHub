import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "../src/lib/prisma";
import { tokenHash } from "../src/lib/auth";
import { testSession } from "./support/identities";
import { createCanonicalChangeset, stageCanonicalBlob } from "../src/source-control/canonical";
import { advanceReference } from "../src/source-control/service";

const client = process.env.DEVHUB_CLI;
if (!client) throw new Error("DEVHUB_CLI must point to the compiled native executable");
const directory = mkdtempSync(join(tmpdir(), "devhub-e2e-"));
const home = join(directory, "home"), root = join(directory, "workspace");
mkdirSync(home); mkdirSync(root);
const secret = randomBytes(32).toString("hex");
const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), DEVHUB_TOKEN: secret };
function cli(args: string[], stdin?: string, success = true, cwd = root): string {
  const result = spawnSync(client!, args, { cwd, env, input: stdin, encoding: "utf8", timeout: 30000 });
  if (success) assert.equal(result.status, 0, args.join(" ") + ": " + result.stderr);
  else assert.notEqual(result.status, 0, args.join(" ") + " was expected to fail");
  return (result.stdout ?? "") + (result.stderr ?? "");
}
const suffix = randomBytes(6).toString("hex");
let daemon: ReturnType<typeof spawn> | undefined;
async function cacheStatus(socketPath: string): Promise<Record<string, number>> {
  return new Promise((resolve, reject) => {
    http.get({ socketPath, path: "/v1/status" }, res => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { data += chunk; });
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
      res.on("error", reject);
    }).on("error", reject);
  });
}
async function main() {
  const user = await db.user.create({ data: { handle: "client-" + suffix, email: "client-" + suffix + "@example.invalid" } });
  const repo = await db.repository.create({ data: { ownerId: user.id, name: "Native CLI", slug: "cli", requireHumanApproval: false } });
  const agent = await db.agentIdentity.create({ data: { ownerId: user.id, name: "client-" + suffix, scopes: [
    "changesets:read", "changesets:write",
  ] } });
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  const credential = await db.agentCredential.create({ data: {
    agentId: agent.id, tokenHash: tokenHash(secret), label: "e2e",
    scopes: ["source:read", "changeset:write"], expiresAt,
  } });
  await db.agentDelegation.create({ data: {
    agentId: agent.id, repositoryId: repo.id, delegatedBy: user.id,
    scopes: ["source:read", "changeset:write"], expiresAt,
  } });
  const { actor: human } = await testSession(user.id);
  const actor = { id: agent.id, type: "AGENT" as const, credentialId: credential.id };
  const obj = await stageCanonicalBlob(repo.id, human, Buffer.from("base version\n").toString("base64"));
  const first = await createCanonicalChangeset(repo.id, actor, {
    apiVersion: 2, parents: [], description: "initial", operations: [
      { kind: "ADD", path: "docs/readme.txt", objectId: obj.id },
    ],
  });
  await advanceReference(repo.id, "main", first.id, null, human);
  const server = "http://127.0.0.1:3000";
  const socket = join(directory, "shared.sock");
  daemon = spawn(process.execPath, ["src/cache/daemon.mjs"], {
    env: {
      ...process.env, DEVHUB_CACHE_DIR: join(directory, "shared-cache"),
      DEVHUB_CACHE_SOCKET: socket, DEVHUB_ORIGIN_URL: server,
      DEVHUB_ORIGIN_TOKEN: secret, DEVHUB_CACHE_REPOSITORIES: repo.id,
      DEVHUB_CACHE_REQUIRE_AUTHORIZATION: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let daemonErrors = "";
  daemon.stderr?.on("data", chunk => { daemonErrors += chunk.toString(); });
  for (let attempt = 0; attempt < 80; attempt++) {
    if (daemon.exitCode !== null) throw new Error("Cache daemon exited: " + daemonErrors);
    if (existsSync(socket)) {
      try { await cacheStatus(socket); break; } catch { /* socket not ready */ }
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!existsSync(socket)) throw new Error("Cache socket unavailable: " + daemonErrors);
  env.DEVHUB_CACHE_SOCKET = socket;
  cli(["auth", "login", "--server", server, "--repository", repo.id, "--token-stdin"], secret + "\n");
  cli(["init", "--server", server, "--repository", repo.id]);
  cli(["select", "--dir", "docs"]);
  cli(["sync"]);
  assert.match(cli(["status", "--json"]), /"changes": \[\]/);
  cli(["hydrate", "docs/readme.txt"]);
  assert.equal(readFileSync(join(root, "docs/readme.txt"), "utf8"), "base version\n");
  const cold = await cacheStatus(socket);
  assert.equal(cold.upstreamRequests, 1, "cold hydration must populate shared cache");
  const second = join(directory, "ci-workspace");
  mkdirSync(second);
  cli(["init", "--server", server, "--repository", repo.id], undefined, true, second);
  cli(["select", "--dir", "docs"], undefined, true, second);
  cli(["sync"], undefined, true, second);
  cli(["hydrate", "docs/readme.txt"], undefined, true, second);
  assert.equal(readFileSync(join(second, "docs/readme.txt"), "utf8"), "base version\n");
  const warm = await cacheStatus(socket);
  assert.equal(warm.upstreamRequests, 1, "warm CI checkout must reuse node cache");
  assert.ok(warm.hits >= 1 && warm.authorizationChecks >= 2, "warm hits must reauthorize");
  daemon.kill("SIGTERM");
  await new Promise(resolve => daemon!.once("exit", resolve));
  const outage = join(directory, "fallback-workspace");
  mkdirSync(outage);
  cli(["init", "--server", server, "--repository", repo.id], undefined, true, outage);
  cli(["select", "--dir", "docs"], undefined, true, outage);
  cli(["sync"], undefined, true, outage);
  cli(["hydrate", "docs/readme.txt"], undefined, true, outage);
  assert.equal(readFileSync(join(outage, "docs/readme.txt"), "utf8"), "base version\n",
    "authoritative download must work when node daemon is offline");
  writeFileSync(join(root, "docs/readme.txt"), "changed version\n");
  assert.match(cli(["status"]), /modified/);
  const output = cli(["changeset", "create", "--message", "Update documentation"]);
  const nextId = output.match(/[a-f0-9]{64}/)?.[0];
  assert.ok(nextId);
  const native = await db.sourceChangeset.findUniqueOrThrow({ where: { id: nextId }, include: { parents: true } });
  assert.equal(native.parents[0].parentId, first.id);
  assert.equal(native.treeId, null);
  const review = cli(["review", "submit", "--title", "Documentation update", "--target", "main"]);
  assert.match(review, /"created": true/);
  assert.equal(await db.sourceReviewRequest.count({ where: { repositoryId: repo.id, changesetId: nextId } }), 1);
  cli(["review", "submit", "--title", "Documentation update", "--target", "main"]);
  assert.equal(await db.sourceReviewRequest.count({ where: { repositoryId: repo.id, changesetId: nextId } }), 1);
  assert.match(cli(["history", "--revision", nextId]), /Update documentation/);
  assert.match(cli(["diff", "--from", first.id, "--to", nextId]), /changed version/);
  assert.match(cli(["blame", "docs/readme.txt", "--revision", nextId]), /"lines"/);
  assert.match(cli(["ancestry", "--left", nextId, "--right", first.id]), new RegExp(first.id));
  assert.match(cli(["merge", "--base", first.id, "--ours", nextId, "--theirs", first.id]), /"clean": true/);
  const state = join(root, ".devhub/workspace.json");
  const before = readFileSync(state);
  cli(["sync"], undefined, false);
  assert.deepEqual(readFileSync(state), before);
  console.log("Native CLI end-to-end verification passed");
}
main().catch(e => { console.error(e); process.exitCode = 1; })
  .finally(async () => {
    if (daemon && daemon.exitCode === null) {
      daemon.kill("SIGTERM");
      await new Promise(resolve => daemon!.once("exit", resolve));
    }
    await db.$disconnect();
    rmSync(directory, { recursive: true, force: true });
  });

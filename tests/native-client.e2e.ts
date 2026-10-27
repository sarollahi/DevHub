import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "../src/lib/prisma";
import { tokenHash } from "../src/lib/auth";
import { createCanonicalChangeset, stageCanonicalBlob } from "../src/source-control/canonical";
import { advanceReference } from "../src/source-control/service";

const client = process.env.DEVHUB_CLI;
if (!client) throw new Error("DEVHUB_CLI must point to the compiled native executable");
const directory = mkdtempSync(join(tmpdir(), "devhub-e2e-"));
const home = join(directory, "home"), root = join(directory, "workspace");
mkdirSync(home); mkdirSync(root);
const secret = randomBytes(32).toString("hex");
const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), DEVHUB_TOKEN: secret };
function cli(args: string[], stdin?: string, success = true): string {
  const result = spawnSync(client!, args, { cwd: root, env, input: stdin, encoding: "utf8", timeout: 30000 });
  if (success) assert.equal(result.status, 0, args.join(" ") + ": " + result.stderr);
  else assert.notEqual(result.status, 0, args.join(" ") + " was expected to fail");
  return (result.stdout ?? "") + (result.stderr ?? "");
}
const suffix = randomBytes(6).toString("hex");
async function main() {
  const user = await db.user.create({ data: { handle: "client-" + suffix, email: "client-" + suffix + "@example.invalid" } });
  const repo = await db.repository.create({ data: { ownerId: user.id, name: "Native CLI", slug: "cli", requireHumanApproval: false } });
  const agent = await db.agentIdentity.create({ data: { ownerId: user.id, name: "client-" + suffix, scopes: [
    "changesets:read", "changesets:write",
  ] } });
  await db.agentCredential.create({ data: { agentId: agent.id, tokenHash: tokenHash(secret), label: "e2e" } });
  const obj = await stageCanonicalBlob(repo.id, Buffer.from("base version\n").toString("base64"));
  const first = await createCanonicalChangeset(repo.id, { id: agent.id, type: "AGENT" }, {
    apiVersion: 2, parents: [], description: "initial", operations: [
      { kind: "ADD", path: "docs/readme.txt", objectId: obj.id },
    ],
  });
  await advanceReference(repo.id, "main", first.id, null, user.id);
  const server = "http://127.0.0.1:3000";
  cli(["auth", "login", "--server", server, "--repository", repo.id, "--token-stdin"], secret + "\n");
  cli(["init", "--server", server, "--repository", repo.id]);
  cli(["select", "--dir", "docs"]);
  cli(["sync"]);
  assert.match(cli(["status", "--json"]), /"changes": \[\]/);
  cli(["hydrate", "docs/readme.txt"]);
  assert.equal(readFileSync(join(root, "docs/readme.txt"), "utf8"), "base version\n");
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
  .finally(async () => { await db.$disconnect(); rmSync(directory, { recursive: true, force: true }); });

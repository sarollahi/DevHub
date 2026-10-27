import { readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { posix } from "node:path";
import { db } from "../src/lib/prisma";
import { assertRepositoryPermission } from "../src/lib/authorization";
import { fromGitRef } from "../src/source-control/git-interoperability-format";
import { gitCacheDirectory } from "../src/source-control/git-interoperability";
import { gitLines, gitText, readGitCommit, gitTreeEntries } from "../src/source-control/git-io";
import { publishGitCommit } from "../src/source-control/git-importer";
import { mutateReference } from "../src/source-control/refs";
import { validPath } from "../src/lib/review-logic";
import type { SourceActor } from "../src/source-control/contracts";

const NULL = "0".repeat(40);
const SHA = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f-]{36}$/i;

async function validateTip(cwd: string, sha: string) {
  let count = 0;
  for await (const item of gitTreeEntries(cwd, sha)) {
    if (++count > 10000 || !validPath(item.path) || !["100644", "100755", "120000"].includes(item.mode)) {
      throw new Error("Unsupported Git tree path, mode, or size");
    }
    if (item.mode === "120000") {
      const target = await gitText(cwd, ["cat-file", "blob", item.sha], 4097);
      const joined = posix.normalize(posix.join(posix.dirname(item.path), target));
      if (!target || target.includes("\0") || target.includes("\\") || posix.isAbsolute(target) ||
        joined === ".." || joined.startsWith("../") || joined.startsWith("/") ||
        Buffer.byteLength(target, "utf8") > 4096) throw new Error("Unsafe symbolic link in incoming Git tree");
    }
  }
}

async function main() {
  const repositoryId = process.env.DEVHUB_GIT_REPOSITORY_ID ?? "";
  const userId = process.env.DEVHUB_GIT_ACTOR_USER ?? "";
  const credentialId = process.env.DEVHUB_GIT_ACTOR_CREDENTIAL ?? "";
  if (!UUID.test(repositoryId) || !UUID.test(userId) || !UUID.test(credentialId) ||
      process.env.DEVHUB_GIT_PUSH_GATE !== "enabled") throw new Error("Git push gateway identity missing");
  const dir = await gitCacheDirectory(repositoryId);
  if (await realpath(process.cwd()) !== await realpath(dir)) throw new Error("Git receive hook invoked outside assigned cache");
  const actor: SourceActor = { type: "HUMAN", id: userId, gitCredentialId: credentialId };
  // The hook runs synchronously before receive-pack can update a projected ref.
  const updates = readFileSync(0, "utf8").trim().split("\n").filter(Boolean);
  if (updates.length !== 1) throw new Error("Exactly one Git ref update per push is supported");
  const parts = updates[0].split(" ");
  if (parts.length !== 3 || !SHA.test(parts[0]) || !SHA.test(parts[1])) {
    throw new Error("Malformed Git receive-pack ref update");
  }
  const [oldSha, newSha, refName] = parts;
  const { name, kind } = fromGitRef(refName);
  if (newSha === NULL) throw new Error("Git ref deletion is not supported");
  if (oldSha === newSha) throw new Error("No-op ref update");
  await assertRepositoryPermission(actor, repositoryId, "ref:update", { branch: name });
  await assertRepositoryPermission(actor, repositoryId, "changeset:write", { allowStaging: true });
  const current = await db.sourceReference.findUnique({ where: {
    repositoryId_name: { repositoryId, name },
  } });
  if ((oldSha === NULL) !== !current || (current?.deletedAt)) {
    throw new Error("Native reference state changed; fetch before pushing");
  }
  if (current) {
    const mapped = await db.gitInteropCommit.findUnique({ where: {
      repositoryId_changesetId: { repositoryId, changesetId: current.changesetId },
    } });
    if (!mapped || mapped.gitSha !== oldSha) throw new Error("Git ref is stale compared to native ref");
    await gitText(dir, ["merge-base", "--is-ancestor", oldSha, newSha], 4096);
  }
  if ((await gitText(dir, ["cat-file", "-t", newSha], 64)).trim() !== "commit") {
    throw new Error("Git push target must be a commit");
  }
  // Cap execution work independent of pack-size and compression limits.
  const commits: string[] = [];
  const args = ["rev-list", "--topo-order", "--reverse", newSha, ...(current ? ["^" + oldSha] : [])];
  for await (const sha of gitLines(dir, args)) {
    if (commits.push(sha) > 2000) throw new Error("Git push exceeds 2,000 commits; split the update");
  }
  for (const sha of commits) {
    if (!SHA.test(sha)) throw new Error("Invalid Git object ID");
    if (await db.gitInteropCommit.findUnique({ where: {
      repositoryId_gitSha: { repositoryId, gitSha: sha },
    } })) continue;
    if (await db.gitImportCommit.findUnique({ where: {
      repositoryId_gitSha: { repositoryId, gitSha: sha },
    } })) continue;
    await validateTip(dir, sha);
    const commit = await readGitCommit(dir, sha);
    await publishGitCommit(repositoryId, dir, commit, async () => {}, actor);
  }
  const exported = await db.gitInteropCommit.findUnique({ where: {
    repositoryId_gitSha: { repositoryId, gitSha: newSha },
  } });
  const imported = await db.gitImportCommit.findUnique({ where: {
    repositoryId_gitSha: { repositoryId, gitSha: newSha },
  } });
  const changesetId = exported?.changesetId ?? imported?.changesetId;
  if (!changesetId) throw new Error("Incoming Git tip does not resolve to a native changeset");
  // Native atomic CAS, validation and protected-branch policies are authoritative.
  // Missing human approvals or stale refs reject the push (no synthetic approvals).
  await mutateReference(repositoryId, actor, {
    name, kind, operation: current ? "UPDATE" : "CREATE",
    changesetId, expectedGeneration: current?.generation ?? null,
    expectedChangesetId: current?.changesetId,
    mutationId: "git-push-" + newSha.slice(0, 40),
  });
  process.stderr.write("DevHub: verified Git push and advanced authoritative native reference\n");
}

main().catch(error => {
  process.stderr.write("DevHub: Git push rejected: " + (error instanceof Error ? error.message : String(error)) + "\n");
  process.exitCode = 1;
}).finally(() => db.$disconnect());

import { createHash } from "node:crypto";
import { readSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { posix } from "node:path";
import { db } from "../src/lib/prisma";
import { assertRepositoryPermission } from "../src/lib/authorization";
import { fromGitRef } from "../src/source-control/git-interoperability-format";
import { gitCacheDirectory, gitCommand } from "../src/source-control/git-interoperability";
import { gitDiff, gitLines, gitText, readGitCommit, gitTreeEntries } from "../src/source-control/git-io";
import { publishGitCommit } from "../src/source-control/git-importer";
import { mutateReferencesBatch, type RefMutationRequest } from "../src/source-control/refs";
import { requireGitLease } from "../src/source-control/git-lease";
import { validPath } from "../src/lib/review-logic";
import type { SourceActor } from "../src/source-control/contracts";

const NULL = "0".repeat(40);
const SHA = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f-]{36}$/i;
const MAX_REFS = 32;
const MAX_COMMITS = 2000;

async function validateTip(cwd: string, sha: string) {
  let count = 0;
  for await (const item of gitTreeEntries(cwd, sha)) {
    if (++count > 10000 || !validPath(item.path) || !["100644", "100755", "120000"].includes(item.mode)) {
      throw new Error("Unsupported Git tree path, mode, or size");
    }
    if (item.mode === "120000") {
      const raw = await gitCommand(cwd, ["cat-file", "blob", item.sha]);
      if (raw.length > 4096) throw new Error("Oversized Git symbolic link");
      const target = new TextDecoder("utf-8", { fatal: true }).decode(raw);
      const joined = posix.normalize(posix.join(posix.dirname(item.path), target));
      if (!target || target.includes("\0") || target.includes("\\") || posix.isAbsolute(target) ||
        joined === ".." || joined.startsWith("../") || joined.startsWith("/") ||
        Buffer.byteLength(target, "utf8") > 4096) throw new Error("Unsafe symbolic link in incoming Git tree");
    }
  }
}


function readUpdates(): Array<{ oldSha: string; newSha: string; ref: string; name: string; kind: "BRANCH" | "TAG" }> {
  // A Git client cannot allocate unbounded memory via the pre-receive input.
  const max = 16 * 1024;
  const data = Buffer.alloc(max + 1);
  let used = 0;
  while (used < data.length) {
    const bytes = readSync(0, data, used, data.length - used, null);
    if (!bytes) break;
    used += bytes;
  }
  if (used > max) throw new Error("Git receive command list exceeds 16 KiB");
  const lines = data.subarray(0, used).toString("utf8").trim().split("\n").filter(Boolean);
  if (!lines.length || lines.length > MAX_REFS) throw new Error("Push must update 1–32 Git references");
  const parsed = lines.map(line => {
    const parts = line.split(" ");
    if (parts.length !== 3 || !SHA.test(parts[0]) || !SHA.test(parts[1])) {
      throw new Error("Malformed Git reference update");
    }
    const [oldSha, newSha, ref] = parts;
    const { name, kind } = fromGitRef(ref);
    if (oldSha === newSha) throw new Error("No-op Git ref update");
    return { oldSha, newSha, ref, name, kind };
  });
  if (new Set(parsed.map(update => update.name)).size !== parsed.length) {
    throw new Error("Duplicate Git target in atomic batch");
  }
  return parsed;
}

function pushOptions() {
  const count = Number(process.env.GIT_PUSH_OPTION_COUNT ?? 0);
  if (!Number.isInteger(count) || count < 0 || count > MAX_REFS + 1) {
    throw new Error("Invalid Git push-option count");
  }
  const options: string[] = [];
  for (let i = 0; i < count; i++) {
    const option = process.env["GIT_PUSH_OPTION_" + i] ?? "";
    if (option.length > 512 || !option.startsWith("devhub-")) {
      throw new Error("Unknown or oversized Git push option");
    }
    options.push(option);
  }
  const reasonOptions = options.filter(x => x.startsWith("devhub-force-reason="));
  if (reasonOptions.length > 1) throw new Error("Only one force reason is permitted");
  const reason = reasonOptions[0]?.slice("devhub-force-reason=".length) ?? "";
  if (reason && reason.trim().length < 10) throw new Error("Force-update reason must explain the rewrite");
  const leases = new Map<string, string>();
  for (const option of options) {
    if (option.startsWith("devhub-force-reason=")) continue;
    if (!option.startsWith("devhub-lease=")) throw new Error("Unsupported Git push option");
    const spec = option.slice("devhub-lease=".length);
    const index = spec.lastIndexOf(":");
    if (index <= 0 || !SHA.test(spec.slice(index + 1))) throw new Error("Invalid Git lease");
    const { name } = fromGitRef(spec.slice(0, index));
    if (leases.has(name)) throw new Error("Duplicate lease option");
    leases.set(name, spec.slice(index + 1));
  }
  return { reason, leases };
}

async function nativeForGitSha(repositoryId: string, sha: string) {
  if (sha === NULL) return null;
  const [exported, imported] = await Promise.all([
    db.gitInteropCommit.findUnique({ where: { repositoryId_gitSha: { repositoryId, gitSha: sha } } }),
    db.gitImportCommit.findUnique({ where: { repositoryId_gitSha: { repositoryId, gitSha: sha } } }),
  ]);
  if (exported && imported && exported.changesetId !== imported.changesetId) {
    throw new Error("Conflicting native identities for Git object");
  }
  return exported?.changesetId ?? imported?.changesetId ?? null;
}

async function main() {
  const repositoryId = process.env.DEVHUB_GIT_REPOSITORY_ID ?? "";
  const userId = process.env.DEVHUB_GIT_ACTOR_USER ?? "";
  const credentialId = process.env.DEVHUB_GIT_ACTOR_CREDENTIAL ?? "";
  const leaseToken = process.env.DEVHUB_GIT_LEASE_TOKEN ?? "";
  if (!UUID.test(repositoryId) || !UUID.test(userId) || !UUID.test(credentialId) || !UUID.test(leaseToken) ||
      process.env.DEVHUB_GIT_PUSH_GATE !== "enabled") throw new Error("Git push gateway identity missing");
  await requireGitLease(repositoryId, leaseToken);
  const dir = await gitCacheDirectory(repositoryId);
  if (await realpath(process.cwd()) !== await realpath(dir)) {
    throw new Error("Git receive hook invoked outside assigned cache");
  }
  const actor: SourceActor = { type: "HUMAN", id: userId, gitCredentialId: credentialId };
  const commands = readUpdates();
  const { reason, leases } = pushOptions();
  const currentByName = new Map<string, Awaited<ReturnType<typeof db.sourceReference.findUnique>>>();
  const requested: Array<{
    oldSha: string; newSha: string; name: string; kind: "BRANCH" | "TAG";
    force: boolean;
  }> = [];
  for (const command of commands) {
    const { name, kind, oldSha, newSha } = command;
    await assertRepositoryPermission(actor, repositoryId, "ref:update", { branch: name });
    const current = await db.sourceReference.findUnique({
      where: { repositoryId_name: { repositoryId, name } },
    });
    currentByName.set(name, current);
    const active = !!current && !current.deletedAt;
    if ((oldSha === NULL) !== !active) {
      throw new Error("Native ref generation differs from Git advertisement; fetch and retry: " + name);
    }
    if (active && await nativeForGitSha(repositoryId, oldSha) !== current!.changesetId) {
      throw new Error("Git ref is stale compared with native ref: " + name);
    }
    if (kind === "TAG" && (current || newSha === NULL)) {
      throw new Error("Native tags are immutable: " + name);
    }
    if (newSha === NULL) {
      if (!current || kind !== "BRANCH") throw new Error("Cannot delete absent or immutable Git ref");
      requested.push({ name, kind, oldSha, newSha, force: false });
      continue;
    }
    if ((await gitText(dir, ["cat-file", "-t", newSha], 64)).trim() !== "commit") {
      throw new Error("Only commits are accepted as Git ref targets");
    }
    let force = false;
    if (active) {
      try { await gitText(dir, ["merge-base", "--is-ancestor", oldSha, newSha], 64); }
      catch { force = true; }
    }
    if (force && (reason.trim().length < 10 || leases.get(name) !== oldSha)) {
      throw new Error("Non-fast-forward requires --force-with-lease and devhub-lease=refs/heads/<name>:<old-sha> with a documented reason");
    }
    requested.push({ name, kind, oldSha, newSha, force });
  }
  if (leases.size && [...leases.keys()].some(name => !requested.some(x => x.name === name && x.force))) {
    throw new Error("A Git lease does not refer to a force-updated branch");
  }
  if (reason && !requested.some(x => x.force)) throw new Error("Force reason provided without a rewritten ref");

  // Import all missing ancestry for all refs once, in topological order.
  // No authoritative ref can move until every proposed object has passed checks.
  const newTips = [...new Set(requested.filter(x => x.newSha !== NULL).map(x => x.newSha))];
  // The disposable Git cache contains only native-published histories.
  // Exclude all mapped reachable refs so a new branch on a deep base imports
  // only its delta rather than traversing/reimporting every ancestor.
  const commits: string[] = [];
  if (newTips.length) {
    for await (const sha of gitLines(dir,
      ["rev-list", "--topo-order", "--reverse", ...newTips, "--not", "--all"])) {
      if (!SHA.test(sha)) throw new Error("Invalid Git object ID");
      if (commits.push(sha) > MAX_COMMITS) throw new Error("Push exceeds 2,000 new Git commits");
    }
  }
  for (const sha of commits) {
    if (await nativeForGitSha(repositoryId, sha)) continue;
    await validateTip(dir, sha);
    const commit = await readGitCommit(dir, sha);
    const changedPaths: string[] = [];
    for await (const delta of gitDiff(dir, sha, commit.parents[0])) {
      if (!validPath(delta.path)) throw new Error("Invalid changed path");
      changedPaths.push(delta.path);
      if (changedPaths.length > 100_000) throw new Error("Excessive changes in Git commit");
    }
    if (changedPaths.length) {
      await assertRepositoryPermission(actor, repositoryId, "changeset:write", { paths: changedPaths });
    }
    await publishGitCommit(repositoryId, dir, commit, async () => {}, actor);
    const imported = await db.gitImportCommit.findUniqueOrThrow({
      where: { repositoryId_gitSha: { repositoryId, gitSha: sha } },
    });
    const rawCommit = await gitCommand(dir, ["cat-file", "commit", sha]);
    await db.gitInteropCommit.createMany({
      data: [{ repositoryId, changesetId: imported.changesetId, gitSha: sha,
        treeSha: commit.treeSha, rawCommit: Uint8Array.from(rawCommit) }], skipDuplicates: true,
    });
    const projection = await db.gitInteropCommit.findUniqueOrThrow({
      where: { repositoryId_changesetId: { repositoryId, changesetId: imported.changesetId } },
    });
    if (projection.gitSha !== sha) throw new Error("Conflicting native-to-Git identity mapping");
  }

  const mutations: RefMutationRequest[] = [];
  for (const entry of requested) {
    const current = currentByName.get(entry.name);
    const changesetId = await nativeForGitSha(repositoryId, entry.newSha);
    if (entry.newSha !== NULL && !changesetId) throw new Error("Git tip is not mapped to a native changeset");
    const operation = entry.newSha === NULL ? "DELETE" :
      current?.deletedAt ? "RESTORE" : current ? "UPDATE" : "CREATE";
    const digest = createHash("sha256").update(JSON.stringify([
      entry.name, operation, entry.oldSha, entry.newSha, current?.generation ?? null,
    ])).digest("hex");
    mutations.push({
      name: entry.name, kind: entry.kind, operation,
      changesetId: changesetId ?? undefined,
      expectedGeneration: current?.generation ?? null,
      expectedChangesetId: current?.changesetId,
      force: entry.force,
      reason: entry.force ? reason : undefined,
      mutationId: "git-batch-" + digest.slice(0, 52),
    });
  }
  await mutateReferencesBatch(repositoryId, actor, mutations, leaseToken);
  process.stderr.write("DevHub: all " + mutations.length + " native Git ref updates committed atomically\n");
}

main().catch(error => {
  process.stderr.write("DevHub: Git push rejected: " +
    (error instanceof Error ? error.message : String(error)) + "\n");
  process.exitCode = 1;
}).finally(() => db.$disconnect());

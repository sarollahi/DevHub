import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, isAbsolute } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { db } from "../lib/prisma";
import { assertRepositoryPermission } from "../lib/authorization";
import { verifiedBlobStream } from "../object-store/service";
import { objectId } from "./storage";
import { SourceControlError, type SourceActor } from "./contracts";
import { validPath } from "../lib/review-logic";
import { gitRefName, serializeIndexUpdates, commitBytes, type GitIndexUpdate } from "./git-interoperability-format";

const SHA = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const maxOutput = 16 * 1024 * 1024;
const maxOp = 100_000;

export async function gitCommand(dir: string, args: string[], input?: Buffer, env: NodeJS.ProcessEnv = {}) {
  const child = spawn("git", ["-C", dir, ...args], {
    stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", ...env },
  });
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  let out = 0, err = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    out += chunk.length;
    if (out > maxOutput) child.kill("SIGKILL");
    else stdout.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    err += chunk.length;
    if (err > maxOutput) child.kill("SIGKILL");
    else stderr.push(chunk);
  });
  const done = new Promise<Buffer>((yes, no) => {
    child.on("error", no);
    child.on("close", code => code === 0 && out <= maxOutput && err <= maxOutput
      ? yes(Buffer.concat(stdout)) : no(new Error(`git ${args[0]} failed: ${Buffer.concat(stderr).toString("utf8").slice(0, 1000)}`)));
  });
  if (input) child.stdin.end(input);
  else child.stdin.end();
  return done;
}

export async function gitObjectExists(dir: string, sha: string) {
  if (!SHA.test(sha)) return false;
  try { await gitCommand(dir, ["cat-file", "-e", sha + "^{object}"]); return true; }
  catch { return false; }
}

export async function gitObjectStream(dir: string, kind: string, source: Readable) {
  const child = spawn("git", ["-C", dir, "hash-object", "-w", "-t", kind, "--stdin"], {
    stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  });
  const chunks: Buffer[] = [], errors: Buffer[] = [];
  child.stdout.on("data", (part: Buffer) => chunks.push(part));
  child.stderr.on("data", (part: Buffer) => errors.push(part));
  const exited = new Promise<void>((yes, no) => {
    child.on("error", no);
    child.on("close", code => code === 0 ? yes() : no(new Error("git hash-object failed: " + Buffer.concat(errors).toString("utf8").slice(0, 500))));
  });
  try {
    await pipeline(source, child.stdin);
    await exited;
  } catch (error) {
    child.kill("SIGKILL");
    void exited.catch(() => {});
    throw error;
  }
  const sha = Buffer.concat(chunks).toString("ascii").trim();
  if (!SHA.test(sha)) throw new Error("Git generated an invalid object ID");
  return sha;
}

export async function gitCacheDirectory(repositoryId: string) {
  if (!UUID.test(repositoryId)) throw new SourceControlError(404, "NOT_FOUND", "Invalid repository identifier");
  const root = process.env.GIT_INTEROP_ROOT;
  if (!root || !isAbsolute(root)) throw new Error("GIT_INTEROP_ROOT must be an absolute, private directory");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink()) throw new Error("Git cache root must not be a symlink");
  const canonical = await realpath(root);
  const dir = join(canonical, repositoryId + ".git");
  try {
    const stat = await lstat(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Unsafe Git cache path");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await gitCommand(canonical, ["init", "--bare", "--initial-branch=main", dir]);
  }
  return dir;
}

async function gitBlob(repositoryId: string, dir: string, nativeId: string): Promise<string> {
  const key = { repositoryId_objectId: { repositoryId, objectId: nativeId } };
  const mapped = await db.gitInteropBlob.findUnique({ where: key });
  if (mapped && await gitObjectExists(dir, mapped.gitSha)) return mapped.gitSha;
  const stored = await db.sourceObject.findUnique({ where: { id: nativeId }, select: {
    id: true, kind: true, data: true, externalId: true, byteSize: true,
  } });
  if (!stored || stored.kind !== "BLOB") throw new Error("Native blob missing during Git export");
  let source: Readable;
  if (stored.data) {
    if (BigInt(stored.data.length) !== stored.byteSize || objectId("BLOB", stored.data) !== nativeId) {
      throw new Error("Native blob failed integrity verification");
    }
    source = Readable.from([Buffer.from(stored.data)]);
  } else {
    if (stored.externalId !== nativeId) throw new Error("Corrupt external object reference");
    const record = await db.storedBlob.findFirst({ where: { id: nativeId, state: "READY" } });
    if (!record || record.rawBytes !== stored.byteSize) throw new Error("External native object not available");
    source = await verifiedBlobStream(record);
  }
  const sha = await gitObjectStream(dir, "blob", source);
  await db.gitInteropBlob.createMany({ data: [{ repositoryId, objectId: nativeId, gitSha: sha }], skipDuplicates: true });
  const committed = await db.gitInteropBlob.findUniqueOrThrow({ where: key });
  if (committed.gitSha !== sha) throw new Error("Git blob projection changed identity");
  return sha;
}

type LegacyEntry = { path: string; objectId: string; mode: string };
type Change = { id: string; authorId: string; message: string; createdAt: Date; treeId: string | null;
  parents: Array<{ parentId: string }>; operations: Array<{
    kind: string; path: string; previousPath: string | null; objectId: string | null; fileMode: string | null;
  }> };

async function existingIndex(dir: string, env: NodeJS.ProcessEnv, paths: string[]) {
  const found = new Map<string, { sha: string; mode: string }>();
  if (!paths.length) return found;
  // Read only paths needed by mode changes/renames; never enumerate full ancestry.
  for (let i = 0; i < paths.length; i += 128) {
    const raw = await gitCommand(dir, ["ls-files", "--stage", "-z", "--", ...paths.slice(i, i + 128)], undefined, env);
    for (const part of raw.toString("utf8").split("\0")) {
      if (!part) continue;
      const match = /^(100644|100755|120000) ([0-9a-f]{40}) [0-3]\t(.+)$/.exec(part);
      if (!match) throw new Error("Unexpected index entry");
      found.set(match[3], { mode: match[1], sha: match[2] });
    }
  }
  return found;
}

async function gitTree(repositoryId: string, dir: string, change: Change, firstParentSha?: string) {
  const temp = await mkdtemp(join(tmpdir(), "devhub-git-index-"));
  const env = { GIT_INDEX_FILE: join(temp, "index") };
  try {
    await gitCommand(dir, firstParentSha ? ["read-tree", firstParentSha] : ["read-tree", "--empty"], undefined, env);
    let operations = change.operations;
    if (change.treeId && !operations.length) {
      // Legacy snapshot-only changesets can be materialized without changing native history.
      const { readCanonicalSnapshotForValidation } = await import("./canonical");
      const snapshot = await readCanonicalSnapshotForValidation(repositoryId, change.id);
      operations = snapshot.entries.map((e: LegacyEntry) => ({ kind: "PUT", path: e.path,
        previousPath: null, objectId: e.objectId, fileMode: e.mode }));
      await gitCommand(dir, ["read-tree", "--empty"], undefined, env);
    }
    if (operations.length > maxOp) throw new Error("Too many Git export operations");
    const needBase = operations.flatMap(op => op.kind === "RENAME" || op.kind === "MOVE" || op.kind === "COPY"
      ? [op.previousPath!] : op.kind === "CHMOD" || !op.fileMode ? [op.path] : []);
    const base = await existingIndex(dir, env, [...new Set(needBase)]);
    const updates: GitIndexUpdate[] = [];
    const additions: GitIndexUpdate[] = [];
    for (const op of operations) {
      if (!validPath(op.path) || (op.previousPath && !validPath(op.previousPath))) throw new Error("Invalid native path");
      if (op.kind === "DELETE") updates.push({ path: op.path });
      else if (op.kind === "RENAME" || op.kind === "MOVE") updates.push({ path: op.previousPath! });
    }
    for (const op of operations) {
      if (op.kind === "DELETE") continue;
      const source = (op.kind === "COPY" || op.kind === "RENAME" || op.kind === "MOVE")
        ? base.get(op.previousPath!) : base.get(op.path);
      const mode = op.fileMode ?? source?.mode ?? "100644";
      if (!["100644", "100755", "120000"].includes(mode)) throw new Error("Unsupported file mode");
      const sha = op.objectId ? await gitBlob(repositoryId, dir, op.objectId) : source?.sha;
      if (!sha) throw new Error("Missing base entry for " + op.path);
      additions.push({ path: op.path, mode, sha });
    }
    if (updates.length || additions.length) {
      await gitCommand(dir, ["update-index", "-z", "--index-info"],
        serializeIndexUpdates([...updates, ...additions]), env);
    }
    const sha = (await gitCommand(dir, ["write-tree"], undefined, env)).toString("ascii").trim();
    if (!SHA.test(sha)) throw new Error("Invalid exported Git tree");
    return sha;
  } finally { await rm(temp, { recursive: true, force: true }); }
}

async function exportCommit(repositoryId: string, dir: string, changesetId: string, seen: Set<string>): Promise<string> {
  if (seen.has(changesetId)) throw new Error("Cycle in native changeset graph");
  const key = { repositoryId_changesetId: { repositoryId, changesetId } };
  const mapped = await db.gitInteropCommit.findUnique({ where: key });
  if (mapped && await gitObjectExists(dir, mapped.gitSha)) return mapped.gitSha;
  const change = await db.sourceChangeset.findFirst({ where: { id: changesetId, repositoryId },
    include: { operations: { orderBy: { position: "asc" } }, parents: { orderBy: { position: "asc" } } } });
  if (!change) throw new Error("Native changeset missing during export");
  seen.add(changesetId);
  try {
    const parents = [];
    for (const edge of change.parents) parents.push(await exportCommit(repositoryId, dir, edge.parentId, seen));
    const treeSha = await gitTree(repositoryId, dir, change as Change, parents[0]);
    const original = await db.gitImportCommit.findUnique({ where: {
      repositoryId_changesetId: { repositoryId, changesetId },
    } });
    // Preserve raw pushed commits so rebuilding the cache never changes mapped Git IDs.
    const bytes = mapped?.rawCommit ? Buffer.from(mapped.rawCommit) : commitBytes({
      treeSha, parents, changeId: changesetId, message: change.message,
      authorId: change.authorId, date: change.createdAt, imported: original ?? undefined,
    });
    if (mapped?.rawCommit) {
      const header = bytes.toString("utf8").split("\n\n")[0];
      const treeHeader = header.split("\n").find(line => line.startsWith("tree "));
      const parentHeaders = header.split("\n").filter(line => line.startsWith("parent ")).map(line => line.slice(7));
      if (treeHeader !== "tree " + treeSha || parentHeaders.join(",") !== parents.join(",")) {
        throw new Error("Raw Git commit does not match authoritative native parents and tree");
      }
    }
    const sha = await gitObjectStream(dir, "commit", Readable.from([bytes]));
    await db.gitInteropCommit.createMany({
      data: [{ repositoryId, changesetId, gitSha: sha, treeSha, rawCommit: bytes }], skipDuplicates: true,
    });
    const saved = await db.gitInteropCommit.findUniqueOrThrow({ where: key });
    if (saved.gitSha !== sha || saved.treeSha !== treeSha) throw new Error("Persisted Git projection conflict");
    return sha;
  } finally { seen.delete(changesetId); }
}

export async function syncGitProjection(repositoryId: string, actor: SourceActor, dir: string) {
  await assertRepositoryPermission(actor, repositoryId, "source:read");
  const repository = await db.repository.findUniqueOrThrow({ where: { id: repositoryId },
    select: { defaultBranch: true } });
  const refs = await db.sourceReference.findMany({ where: { repositoryId, deletedAt: null },
    select: { name: true, kind: true, changesetId: true, generation: true } });
  const native = new Map<string, string>();
  for (const ref of refs) {
    const gitName = gitRefName(ref.name, ref.kind);
    if (native.has(gitName)) throw new Error("Duplicate projected Git reference");
    native.set(gitName, await exportCommit(repositoryId, dir, ref.changesetId, new Set()));
  }
  const raw = await gitCommand(dir, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/tags"]);
  const previous = new Map<string, string>();
  for (const row of raw.toString("ascii").trim().split("\n")) {
    if (!row) continue;
    const [name, sha] = row.split(" ");
    previous.set(name, sha);
  }
  // Git's refs are derived. Always overwrite stale cache state from native refs.
  const script = ["start"];
  for (const [name, sha] of native) {
    if (previous.get(name) !== sha) script.push(`update ${name} ${sha}`);
  }
  for (const name of previous.keys()) {
    if (!native.has(name)) script.push(`delete ${name}`);
  }
  script.push("prepare", "commit", "");
  await gitCommand(dir, ["update-ref", "--stdin"], Buffer.from(script.join("\n")));
  await gitCommand(dir, ["symbolic-ref", "HEAD", "refs/heads/" + repository.defaultBranch]);
  // A ref may change while its export is running. Do not advertise a torn snapshot.
  const latest = await db.sourceReference.findMany({ where: { repositoryId, deletedAt: null },
    select: { name: true, changesetId: true, generation: true } });
  if (latest.length !== refs.length || latest.some(now => !refs.some(before =>
    now.name === before.name && now.changesetId === before.changesetId && now.generation === before.generation))) {
    throw new SourceControlError(409, "GIT_EXPORT_RACE", "Native refs changed during Git projection; retry");
  }
}

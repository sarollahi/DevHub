import { createHash, randomUUID } from "node:crypto";
import { Prisma, type SourceOperationKind } from "@prisma/client";
import { db } from "../lib/prisma";
import { validPath } from "../lib/review-logic";
import { deriveChangesetMetadata } from "./derived";
import { allowedGitDirectory, gitDiff, gitLines, gitText, gitTreeEntries, readGitCommit, type GitCommit } from "./git-io";
import { stageGitBlob, verifyAndReadBlob } from "./git-import-blobs";
import { mutateReference } from "./refs";
import { assertRepositoryPermission } from "../lib/authorization";
import { SourceControlError, type SourceActor } from "./contracts";
import { SnapshotTree, publishedSnapshotRoot } from "./snapshot-tree";
import { applyHistoricalOperations } from "./snapshot-backfill";

type ImportedOperation = {
  kind: SourceOperationKind; path: string; objectId: string | null;
  fileMode: string | null; previousPath: string | null; position: number;
};
type NativeEntry = { objectId: string; mode: string };
type NativeTree = Map<string, NativeEntry>;
const SHA = /^[a-f0-9]{40}$|^[a-f0-9]{64}$/;
const MODES = new Set(["100644", "100755", "120000"]);
const leaseMs = 10 * 60 * 1000;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

async function assertImportAuthority(repositoryId: string, actor: SourceActor) {
  if (actor.type !== "HUMAN" || !actor.sessionId) {
    throw new SourceControlError(403, "HUMAN_REQUIRED", "Import requires an authenticated human session");
  }
  const repo = await db.repository.findUnique({ where: { id: repositoryId }, select: { ownerId: true } });
  if (!repo || repo.ownerId !== actor.id) {
    throw new SourceControlError(403, "IMPORT_OWNER_REQUIRED", "Only the owner may approve imported references");
  }
  await assertRepositoryPermission(actor, repositoryId, "admin");
  await assertRepositoryPermission(actor, repositoryId, "review");
}

export async function createGitImport(repositoryId: string, sourcePath: string, actor: SourceActor) {
  await assertImportAuthority(repositoryId, actor);
  const directory = await allowedGitDirectory(sourcePath);
  const repository = await db.repository.findUnique({ where: { id: repositoryId } });
  if (!repository) throw new Error("Destination repository does not exist");
  const existing = await db.gitImportJob.findUnique({
    where: { repositoryId_sourcePath: { repositoryId, sourcePath: directory } },
  });
  if (existing) return db.gitImportJob.update({ where: { id: existing.id }, data: {
    authorizedUserId: actor.id, authorizedSessionId: actor.sessionId,
  } });
  return db.gitImportJob.create({ data: { repositoryId, sourcePath: directory,
    authorizedUserId: actor.id, authorizedSessionId: actor.sessionId } });
}

export async function requestGitImport(jobId: string, verifyOnly = false, actor?: SourceActor) {
  const job = await db.gitImportJob.findUniqueOrThrow({ where: { id: jobId } });
  if (actor) await assertImportAuthority(job.repositoryId, actor);
  const updated = await db.gitImportJob.updateMany({
    where: { id: jobId, OR: [
      { status: { in: ["COMPLETED", "FAILED", "QUEUED", "VERIFY_QUEUED"] } },
      { status: { in: ["RUNNING", "VERIFYING"] }, leaseUntil: { lt: new Date() } },
    ] },
    data: { status: verifyOnly ? "VERIFY_QUEUED" : "QUEUED",
      leaseUntil: null, workerId: null, lastError: null, completedAt: null,
      ...(actor ? { authorizedUserId: actor.id, authorizedSessionId: actor.sessionId } : {}),
    },
  });
  if (!updated.count) throw new Error("Import is already owned by a live worker");
  return db.gitImportJob.findUniqueOrThrow({ where: { id: job.id } });
}

async function claimImport(jobId: string) {
  const workerId = randomUUID();
  const now = new Date();
  const job = await db.gitImportJob.findUniqueOrThrow({ where: { id: jobId } });
  const isVerify = job.status === "VERIFY_QUEUED" || job.status === "VERIFYING";
  const claimed = await db.gitImportJob.updateMany({
    where: { id: jobId, OR: [
      { status: { in: ["QUEUED", "VERIFY_QUEUED"] } },
      { status: { in: ["RUNNING", "VERIFYING"] }, leaseUntil: { lt: now } },
    ] },
    data: { workerId, status: isVerify ? "VERIFYING" : "RUNNING",
      leaseUntil: new Date(now.getTime() + leaseMs),
      startedAt: job.startedAt || now, lastError: null },
  });
  if (!claimed.count) throw new Error("Job is not queued or its current worker still holds the lease");
  const pulse = async () => {
    const result = await db.gitImportJob.updateMany({ where: { id: jobId, workerId },
      data: { leaseUntil: new Date(Date.now() + leaseMs) } });
    if (!result.count) throw new Error("Import lease was lost");
  };
  return { job, workerId, pulse, isVerify };
}

function normalizedPath(path: string, mode?: string) {
  if (!validPath(path)) throw new Error("Git path is not supported by native path validation: " + path);
  if (mode && !MODES.has(mode)) throw new Error("Unsupported Git file mode " + mode + " at " + path);
}

async function changedFiles(repositoryId: string, cwd: string, commit: GitCommit, pulse: () => Promise<void>) {
  const operations: ImportedOperation[] = [];
  const modified = new Set<string>();
  for await (const delta of gitDiff(cwd, commit.sha, commit.parents[0])) {
    normalizedPath(delta.path, delta.newMode === "000000" ? undefined : delta.newMode);
    if (modified.has(delta.path)) throw new Error("Duplicate Git delta path");
    modified.add(delta.path);
    if (operations.length >= 100_000) throw new Error("Git commit exceeds the importer per-commit operation limit");
    let kind: SourceOperationKind, objectId: string | null = null, fileMode: string | null = null;
    if (delta.status === "D") {
      kind = "DELETE";
    } else if (delta.status === "A") {
      kind = "ADD"; fileMode = delta.newMode;
      objectId = await stageGitBlob(repositoryId, cwd, delta.newSha, pulse);
    } else if (delta.oldSha === delta.newSha && delta.oldMode !== delta.newMode) {
      kind = "CHMOD"; fileMode = delta.newMode;
    } else {
      kind = "MODIFY"; fileMode = delta.newMode;
      objectId = await stageGitBlob(repositoryId, cwd, delta.newSha, pulse);
    }
    operations.push({ kind, path: delta.path, objectId, fileMode, previousPath: null, position: 0 });
    if (operations.length % 250 === 0) await pulse();
  }
  // File-to-directory replacements must delete the old path before adding children.
  operations.sort((a, b) => (a.kind === "DELETE" ? 0 : 1) - (b.kind === "DELETE" ? 0 : 1)
    || Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  operations.forEach((entry, index) => { entry.position = index; });
  return operations;
}

export async function publishGitCommit(repositoryId: string, cwd: string, commit: GitCommit, pulse: () => Promise<void>, actor?: SourceActor) {
  const previously = await db.gitImportCommit.findUnique({
    where: { repositoryId_gitSha: { repositoryId, gitSha: commit.sha } },
  });
  if (previously) {
    if (previously.gitTreeSha !== commit.treeSha) throw new Error("Persisted Git SHA maps to a different tree");
    return false;
  }
  if (new Set(commit.parents).size !== commit.parents.length) throw new Error("Duplicate Git parent");
  const [imports, exports] = await Promise.all([
    db.gitImportCommit.findMany({ where: { repositoryId, gitSha: { in: commit.parents } },
      select: { gitSha: true, changesetId: true } }),
    db.gitInteropCommit.findMany({ where: { repositoryId, gitSha: { in: commit.parents } },
      select: { gitSha: true, changesetId: true } }),
  ]);
  const parentMap = new Map([...imports, ...exports].map(p => [p.gitSha, p.changesetId]));
  if (commit.parents.some(sha => !parentMap.has(sha))) throw new Error("Missing native parent for " + commit.sha);
  const parents = commit.parents.map(sha => parentMap.get(sha)!);
  const operations = await changedFiles(repositoryId, cwd, commit, pulse);
  if (actor) await assertRepositoryPermission(actor, repositoryId, "changeset:write", {
    paths: operations.flatMap(op => op.previousPath ? [op.path, op.previousPath] : [op.path]),
  });
  const changesetId = digest(JSON.stringify([3, repositoryId, commit.sha, commit.treeSha, parents,
    commit.author, commit.committer, commit.message, operations]));
  const meta = deriveChangesetMetadata(operations.map(op => ({
    kind: op.kind as "PUT", path: op.path, previousPath: op.previousPath ?? undefined, objectId: op.objectId ?? undefined,
  })));
  await db.$transaction(async tx => {
    if (actor) await assertRepositoryPermission(actor, repositoryId, "changeset:write", {
      paths: operations.flatMap(op => op.previousPath ? [op.path, op.previousPath] : [op.path]),
    }, tx);
    if (await tx.gitImportCommit.findUnique({ where: { repositoryId_gitSha: { repositoryId, gitSha: commit.sha } } })) return;
    // Imported commits must publish the same immutable path index as native
    // changesets. A separate post-import backfill would break Git projections,
    // native reads and crash recovery between the commit and its root.
    const tree = new SnapshotTree(tx);
    let parentRoot = tree.empty();
    if (parents.length) {
      const published = await publishedSnapshotRoot(tx, repositoryId, parents[0]);
      if (!published) {
        throw new SourceControlError(409, "SNAPSHOT_NOT_MATERIALIZED",
          "Import parent requires checkpoint migration before incremental import");
      }
      parentRoot = published.rootId;
      await tree.count(parentRoot);
    }
    const nextRoot = await applyHistoricalOperations(tree, parentRoot, operations);
    await tree.persist(nextRoot);
    // One transaction publishes the complete change, its ancestry, imported identity, and event.
    await tx.sourceChangeset.create({ data: {
      id: changesetId, repositoryId, treeId: null,
      authorId: "GIT:" + commit.author.name + " <" + commit.author.email + ">",
      message: commit.message, createdAt: commit.author.date,
    } });
    await tx.sourceSnapshotRoot.create({ data: {
      repositoryId, changesetId, rootId: nextRoot,
    } });
    if (parents.length) await tx.sourceChangesetParent.createMany({ data: parents.map((parentId, position) => ({
      changesetId, parentId, position,
    })) });
    for (let i = 0; i < operations.length; i += 300) {
      await tx.sourceFileOperation.createMany({ data: operations.slice(i, i + 300).map(op => ({
        changesetId, ...op,
      })) });
    }
    await tx.sourceValidation.create({ data: {
      changesetId, state: "SUCCESS", ...meta,
      summary: "Git metadata and referenced object hashes checked during native import; code execution and independent history verification are separate",
    } });
    await tx.gitImportCommit.create({ data: {
      repositoryId, gitSha: commit.sha, changesetId, gitTreeSha: commit.treeSha,
      authorName: commit.author.name, authorEmail: commit.author.email,
      authorDate: commit.author.date, authorTimezone: commit.author.timezone,
      committerName: commit.committer.name, committerEmail: commit.committer.email,
      committerDate: commit.committer.date, committerTimezone: commit.committer.timezone,
    } });
    await tx.sourceQueryIndexJob.create({ data: { repositoryId, changesetId } });
    await tx.sourceChangesetEvent.create({ data: {
      repositoryId, changesetId, kind: "changeset.imported",
      payload: { apiVersion: 2, source: "git", gitSha: commit.sha, parents, operationCount: operations.length },
    } });
    await tx.auditEvent.create({ data: {
      repositoryId, actorType: "HUMAN", actorId: "git-import", action: "changeset.imported",
      subjectId: changesetId, metadata: { gitSha: commit.sha, operationCount: operations.length },
    } });
  }, { timeout: 120_000, maxWait: 30_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  return true;
}

type GitRef = { name: string; commitSha: string; objectSha: string };
async function gitRefs(cwd: string): Promise<GitRef[]> {
  const refs: GitRef[] = [];
  for await (const line of gitLines(cwd, ["for-each-ref",
    "--format=%(refname)%00%(objectname)%00%(*objectname)", "refs/heads", "refs/tags"])) {
    const [name, objectSha] = line.split("\0");
    if (!name || !objectSha) throw new Error("Invalid Git reference record");
    normalizedPath(name);
    const commitSha = (await gitText(cwd, ["rev-parse", "--verify", name + "^{commit}"], 128)).trim();
    if (!SHA.test(commitSha)) throw new Error("Git ref does not resolve to a commit");
    refs.push({ name, objectSha, commitSha });
  }
  return refs;
}

async function publishGitRefs(repositoryId: string, cwd: string, pulse: () => Promise<void>, actor: SourceActor) {
  await assertImportAuthority(repositoryId, actor);
  const refs = await gitRefs(cwd);
  const repository = await db.repository.findUniqueOrThrow({ where: { id: repositoryId }, select: { ownerId: true } });
  for (const ref of refs) {
    const mapped = await db.gitImportCommit.findUnique({
      where: { repositoryId_gitSha: { repositoryId, gitSha: ref.commitSha } },
    });
    if (!mapped) throw new Error("Git ref changed during import; resume to include new commits: " + ref.name);
    const name = ref.name.startsWith("refs/heads/") ? ref.name.slice("refs/heads/".length)
      : ref.name.startsWith("refs/tags/") ? "tags/" + ref.name.slice("refs/tags/".length) : "";
    if (!name || !validPath(name)) throw new Error("Unsupported Git ref: " + ref.name);
    const kind = ref.name.startsWith("refs/tags/") ? "TAG" : "BRANCH";
    const existing = await db.sourceReference.findUnique({ where: { repositoryId_name: { repositoryId, name } } });
    if (existing?.changesetId === mapped.changesetId && !existing.deletedAt) continue;
    if (existing) {
      const prior = await db.gitImportCommit.findUnique({ where: {
        repositoryId_changesetId: { repositoryId, changesetId: existing.changesetId },
      } });
      if (!prior) throw new Error("Ref belongs to native work; manual reconciliation required: " + name);
      if (kind === "TAG") throw new Error("Git tag changed; immutable native tags require manual reconciliation: " + name);
      await gitText(cwd, ["merge-base", "--is-ancestor", prior.gitSha, ref.commitSha], 256);
    }
    // The real session is revalidated on each imported ref; revoked sessions fail closed.
    await assertImportAuthority(repositoryId, actor);
    await assertRepositoryPermission(actor, repositoryId, "ref:update", { branch: name });
    await db.$transaction(async tx => {
      await tx.sourceChangeApproval.upsert({ where: {
        changesetId_userId: { changesetId: mapped.changesetId, userId: repository.ownerId },
      }, create: { changesetId: mapped.changesetId, userId: repository.ownerId, decision: "APPROVED" },
      update: { decision: "APPROVED" } });
      await tx.auditEvent.create({ data: {
        repositoryId, actorType: "HUMAN", actorId: repository.ownerId,
        action: "changeset.import-approved", subjectId: mapped.changesetId,
        metadata: { originalGitRef: ref.name, originalGitObjectSha: ref.objectSha },
      } });
    });
    await mutateReference(repositoryId, actor, {
      name, kind, operation: existing ? existing.deletedAt ? "RESTORE" : "UPDATE" : "CREATE",
      changesetId: mapped.changesetId, expectedGeneration: existing?.generation ?? null,
      expectedChangesetId: existing?.changesetId,
      mutationId: "git-import-" + digest(JSON.stringify([name, mapped.changesetId])).slice(0, 50),
    });
    await pulse();
  }
  return refs;
}

function applyNative(state: NativeTree, op: ImportedOperation) {
  const original = state.get(op.path);
  if (op.kind === "ADD" || op.kind === "PUT" || op.kind === "MODIFY") {
    if (!op.objectId) throw new Error("Native change missing blob");
    state.set(op.path, { objectId: op.objectId, mode: op.fileMode || original?.mode || "100644" });
  } else if (op.kind === "DELETE") {
    if (!state.delete(op.path)) throw new Error("Native deletion without source path: " + op.path);
  } else if (op.kind === "CHMOD") {
    if (!original || !op.fileMode) throw new Error("Native mode change without source");
    state.set(op.path, { ...original, mode: op.fileMode });
  } else if (op.kind === "COPY" || op.kind === "RENAME" || op.kind === "MOVE") {
    const prior = state.get(op.previousPath!);
    if (!prior) throw new Error("Native rename/copy without source");
    if (op.kind !== "COPY") state.delete(op.previousPath!);
    state.set(op.path, prior);
  } else throw new Error("Unsupported native operation");
}

async function verifyNativeTree(repositoryId: string, cwd: string, sha: string) {
  const state: NativeTree = new Map();
  for await (const ancestorSha of gitLines(cwd, ["rev-list", "--first-parent", "--reverse", sha])) {
    const mapped = await db.gitImportCommit.findUniqueOrThrow({
      where: { repositoryId_gitSha: { repositoryId, gitSha: ancestorSha } },
    });
    let cursor = 0;
    while (true) {
      const ops = await db.sourceFileOperation.findMany({
        where: { changesetId: mapped.changesetId, position: { gte: cursor } },
        orderBy: { position: "asc" }, take: 500,
      });
      if (!ops.length) break;
      for (const op of ops) applyNative(state, op);
      cursor = ops[ops.length - 1].position + 1;
    }
  }
  let count = 0;
  for await (const entry of gitTreeEntries(cwd, sha)) {
    normalizedPath(entry.path, entry.mode);
    const expected = await db.gitImportBlob.findUnique({
      where: { repositoryId_gitSha: { repositoryId, gitSha: entry.sha } },
    });
    const actual = state.get(entry.path);
    if (!expected || !actual || actual.objectId !== expected.objectId || actual.mode !== entry.mode) {
      throw new Error("Imported native tree differs from Git: " + sha + " " + entry.path);
    }
    state.delete(entry.path);
    count++;
  }
  if (state.size) throw new Error("Imported native tree contains paths absent in Git: " + sha);
  return count;
}

export async function verifyGitImport(jobId: string, pulse: () => Promise<void> = async () => {}, checkRefs = true) {
  const job = await db.gitImportJob.findUniqueOrThrow({ where: { id: jobId } });
  const cwd = await allowedGitDirectory(job.sourcePath);
  await gitText(cwd, ["fsck", "--full", "--no-reflogs"], 1024 * 1024);
  let count = 0;
  const sample = new Set<string>();
  for await (const sha of gitLines(cwd, ["rev-list", "--topo-order", "--reverse", "--all"])) {
    const source = await readGitCommit(cwd, sha);
    const mapped = await db.gitImportCommit.findUnique({
      where: { repositoryId_gitSha: { repositoryId: job.repositoryId, gitSha: sha } },
    });
    if (!mapped || mapped.gitTreeSha !== source.treeSha
      || mapped.authorEmail !== source.author.email || mapped.authorDate.getTime() !== source.author.date.getTime()
      || mapped.committerEmail !== source.committer.email || mapped.committerDate.getTime() !== source.committer.date.getTime()) {
      throw new Error("Commit metadata not preserved: " + sha);
    }
    const native = await db.sourceChangeset.findFirst({ where: { id: mapped.changesetId, repositoryId: job.repositoryId },
      include: { parents: { orderBy: { position: "asc" } }, operations: { orderBy: { position: "asc" } } } });
    if (!native || native.message !== source.message || native.parents.length !== source.parents.length) {
      throw new Error("Native changeset incomplete: " + sha);
    }
    for (let i = 0; i < source.parents.length; i++) {
      const parent = await db.gitImportCommit.findUniqueOrThrow({ where: {
        repositoryId_gitSha: { repositoryId: job.repositoryId, gitSha: source.parents[i] },
      } });
      if (native.parents[i].parentId !== parent.changesetId) throw new Error("Ancestry mismatch: " + sha);
    }
    // Diffs, file modes and object mappings are independently recomputed from Git.
    const expected: Array<{ path: string; kind: string; mode: string | null; sha: string | null }> = [];
    for await (const delta of gitDiff(cwd, sha, source.parents[0])) {
      expected.push({ path: delta.path,
        kind: delta.status === "D" ? "DELETE" : delta.status === "A" ? "ADD"
          : delta.oldSha === delta.newSha && delta.oldMode !== delta.newMode ? "CHMOD" : "MODIFY",
        mode: delta.status === "D" ? null : delta.newMode,
        sha: delta.status === "D" || delta.oldSha === delta.newSha ? null : delta.newSha });
    }
    expected.sort((a, b) => a.path.localeCompare(b.path));
    const actual = native.operations.sort((a, b) => a.path.localeCompare(b.path));
    if (expected.length !== actual.length) throw new Error("Native diff length mismatch: " + sha);
    for (let i = 0; i < expected.length; i++) {
      const a = actual[i], e = expected[i];
      if (a.path !== e.path || a.kind !== e.kind || a.fileMode !== e.mode) throw new Error("Native diff mismatch: " + sha + " " + e.path);
      if (e.sha) {
        const blob = await db.gitImportBlob.findUniqueOrThrow({
          where: { repositoryId_gitSha: { repositoryId: job.repositoryId, gitSha: e.sha } },
        });
        if (blob.objectId !== a.objectId) throw new Error("Imported file hash mismatch: " + e.path);
      }
    }
    if (source.parents.length > 1 && sample.size < 3) sample.add(sha);
    if (count === 0) sample.add(sha);
    count++;
    if (count % 250 === 0) await pulse();
  }
  const refs = await gitRefs(cwd);
  for (const ref of refs) {
    if (!checkRefs) { if (sample.size < 8) sample.add(ref.commitSha); continue; }
    const mapped = await db.gitImportCommit.findUniqueOrThrow({
      where: { repositoryId_gitSha: { repositoryId: job.repositoryId, gitSha: ref.commitSha } },
    });
    const current = await db.sourceReference.findUnique({
      where: { repositoryId_name: { repositoryId: job.repositoryId, name: ref.name.startsWith("refs/heads/")
        ? ref.name.slice("refs/heads/".length) : "tags/" + ref.name.slice("refs/tags/".length) } },
    });
    if (current?.changesetId !== mapped.changesetId) throw new Error("Reference mismatch: " + ref.name);
    if (sample.size < 8) sample.add(ref.commitSha);
  }
  let verifiedPaths = 0;
  for (const sha of sample) { verifiedPaths += await verifyNativeTree(job.repositoryId, cwd, sha); await pulse(); }
  // Verify all unique blob chunks through their native content-addressed hashes.
  let cursor: string | undefined;
  while (true) {
    const objects = await db.gitImportBlob.findMany({
      where: { repositoryId: job.repositoryId, ...(cursor ? { gitSha: { gt: cursor } } : {}) },
      orderBy: { gitSha: "asc" }, take: 100,
    });
    if (!objects.length) break;
    for (const object of objects) await verifyAndReadBlob(db, object.objectId, 0);
    cursor = objects[objects.length - 1].gitSha;
    await pulse();
  }
  return { commits: count, referenceCount: refs.length, treesVerified: sample.size, treePathsVerified: verifiedPaths };
}

export async function runGitImport(jobId: string) {
  const { job, workerId, pulse, isVerify } = await claimImport(jobId);
  const heartbeat = setInterval(() => { void pulse().catch(error => console.error("Import heartbeat failed", error)); }, 30000);
  heartbeat.unref();
  try {
    const cwd = await allowedGitDirectory(job.sourcePath);
    if (!isVerify) {
      await gitText(cwd, ["fsck", "--full", "--no-reflogs"], 1024 * 1024);
      for await (const sha of gitLines(cwd, ["rev-list", "--topo-order", "--reverse", "--all"])) {
        const commit = await readGitCommit(cwd, sha);
        const inserted = await publishGitCommit(job.repositoryId, cwd, commit, pulse);
        if (inserted) await db.gitImportJob.updateMany({ where: { id: jobId, workerId },
          data: { imported: { increment: 1 }, lastGitSha: sha } });
        await pulse();
      }
      await verifyGitImport(jobId, pulse, false);
      if (!job.authorizedUserId || !job.authorizedSessionId) {
        throw new SourceControlError(403, "IMPORT_AUTHORIZATION_REQUIRED", "Reauthorize the import with an authenticated human session");
      }
      await publishGitRefs(job.repositoryId, cwd, pulse, {
        type: "HUMAN", id: job.authorizedUserId, sessionId: job.authorizedSessionId,
      });
    }
    const result = await verifyGitImport(jobId, pulse);
    await db.gitImportJob.updateMany({ where: { id: jobId, workerId }, data: {
      status: "COMPLETED", verifiedAt: new Date(), completedAt: new Date(),
      workerId: null, leaseUntil: null, lastError: null,
    } });
    return result;
  } catch (error) {
    await db.gitImportJob.updateMany({ where: { id: jobId, workerId }, data: {
      status: "FAILED", workerId: null, leaseUntil: null,
      lastError: error instanceof Error ? error.message.slice(0, 4000) : String(error),
    } });
    throw error;
  } finally { clearInterval(heartbeat); }
}

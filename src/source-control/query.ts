import { AsyncLocalStorage } from "node:async_hooks";
import { ensureIndexJob } from "../workers/query-indexer";
import { enqueueDerived, readDerived } from "./derived-index";
import { indexedFileHistory, indexedLinearAncestry, indexedDagMergeBases, indexedDagIsAncestor } from "./derived-queries";
import { exactDagReachability, exactDagAncestors, exactDagMergeBases, exactDagPathImpact, exactDagContributions } from "./dag-queries";
import { indexedBlamePage, MAX_TEXT_BYTES, latestBlameFile } from "./indexed-blame";
import { db } from "../lib/prisma";
import { validPath } from "../lib/review-logic";
import { SourceControlError, type TreeEntry, type SourceActor } from "./contracts";
import { decodeTree, encodeTree, objectId } from "./storage";
import { getTree as readTree } from "./service";
import { SnapshotTree, publishedSnapshotRoot } from "./snapshot-tree";
import { verifiedBlobStream } from "../object-store/service";
import { blameLines, compareEntries, mergeEntries, textPatch } from "./query-algorithms";

const queryContext = new AsyncLocalStorage<{ actor: SourceActor; repositoryId: string }>();
export function runAuthorizedQuery<T>(actor: SourceActor, repositoryId: string, task: () => Promise<T>): Promise<T> {
  return queryContext.run({ actor, repositoryId }, task);
}
function requireQueryActor(repositoryId: string): SourceActor {
  const access = queryContext.getStore();
  if (!access || access.repositoryId !== repositoryId) throw new SourceControlError(401, "UNAUTHORIZED", "Authenticated query context required");
  return access.actor;
}
const digest = /^[a-f0-9]{64}$/;
const chunks = <T>(values: T[], size = 800): T[][] =>
  Array.from({ length: Math.ceil(values.length / size) }, (_, i) => values.slice(i * size, (i + 1) * size));
const limitQuery = (number: number, max = 200) => Number.isSafeInteger(number) && number > 0 ? Math.min(max, number) : 50;

// Immutable revisions are safe to cache after repository authorization.
// LRU bound prevents unbounded server memory growth across repositories.
type TreeResult = Awaited<ReturnType<typeof readTree>>;
const treeCache = new Map<string, TreeResult>();
async function cachedTree(repositoryId: string, id: string): Promise<TreeResult> {
  const key = repositoryId + ":" + id;
  const cached = treeCache.get(key);
  if (cached) { treeCache.delete(key); treeCache.set(key, cached); return cached; }
  const value = await readTree(repositoryId, id, requireQueryActor(repositoryId));
  treeCache.set(key, value);
  if (treeCache.size > 24) treeCache.delete(treeCache.keys().next().value!);
  return value;
}


export async function resolveRevision(repositoryId: string, revision: string): Promise<string> {
  requireQueryActor(repositoryId);
  if (!revision || revision.length > 200) throw new SourceControlError(422, "INVALID_REVISION", "A revision digest or reference name is required");
  const id = digest.test(revision)
    ? revision
    : (await db.sourceReference.findUnique({ where: { repositoryId_name: {
      repositoryId, name: revision.startsWith("refs/") ? revision.slice(5) : revision,
    } }, select: { changesetId: true } }))?.changesetId;
  if (!id || !(await db.sourceChangeset.findFirst({ where: { id, repositoryId }, select: { id: true } }))) {
    throw new SourceControlError(404, "REVISION_NOT_FOUND", "Revision does not exist in this repository");
  }
  await ensureIndexJob(repositoryId, id);
  await enqueueDerived(repositoryId, id, ["ancestry", "history", "changed-paths", "impact", "directory"]);
  return id;
}

// PostgreSQL's recursive UNION removes already visited vertices even in wide
// merge-heavy DAGs. Edges are read from the parent table, not from file trees.
// Legacy bulk ancestry helper retained for callers that explicitly request
// the complete DAG. Ordinary history and merge-base queries avoid this map.
/** Explicit unpaged legacy helper. Ordinary APIs use bounded ancestor pages. */
export async function ancestors(repositoryId: string, revision: string): Promise<string[]> {
  const id = await resolveRevision(repositoryId, revision);
  return (await exactDagAncestors(repositoryId, id, 2_147_483_647)).ancestors;
}

export async function isAncestor(repositoryId: string, ancestor: string, descendant: string): Promise<boolean> {
  const [a, d] = await Promise.all([resolveRevision(repositoryId, ancestor), resolveRevision(repositoryId, descendant)]);
  const indexed = await indexedDagIsAncestor(repositoryId, a, d);
  return indexed ?? exactDagReachability(repositoryId, a, d);
}

export async function mergeBases(repositoryId: string, leftRevision: string, rightRevision: string) {
  const [left, right] = await Promise.all([
    resolveRevision(repositoryId, leftRevision), resolveRevision(repositoryId, rightRevision),
  ]);
  const indexed = await indexedDagMergeBases(repositoryId, left, right);
  return indexed ?? exactDagMergeBases(repositoryId, left, right);
}

export async function ancestryQuery(repositoryId: string, revision: string, other?: string, max = 100) {
  const resolved = await resolveRevision(repositoryId, revision);
  const size = limitQuery(max, 1000);
  const accelerated = await indexedLinearAncestry(repositoryId, resolved, size);
  const result = accelerated ?? await exactDagAncestors(repositoryId, resolved, size);
  return { ...result, mergeBases: other ? await mergeBases(repositoryId, resolved, other) : [] };
}

// Exact immutable-root reads require no complete snapshot reconstruction.
async function indexedSnapshot<T>(
  repositoryId: string, revision: string,
  query: (tree: SnapshotTree, root: string) => Promise<T>,
): Promise<T | undefined> {
  const root = await db.sourceSnapshotRoot.findFirst({
    where: { repositoryId, changesetId: revision }, select: { rootId: true },
  });
  if (!root) {
    const change = await db.sourceChangeset.findFirst({
      where: { repositoryId, id: revision }, select: { treeId: true },
    });
    if (!change?.treeId) {
      throw new SourceControlError(409, "SNAPSHOT_NOT_MATERIALIZED",
        "Revision requires incremental checkpoint migration before indexed reads");
    }
    return undefined;
  }
  return db.$transaction(async tx => {
    const tree = new SnapshotTree(tx);
    await tree.count(root.rootId);
    return query(tree, root.rootId);
  }, { timeout: 30000 });
}

export async function treeQuery(repositoryId: string, revision: string, directory = "", max = 200, cursor = "") {
  if (directory && !validPath(directory)) throw new SourceControlError(422, "INVALID_PATH", "Invalid repository path");
  const id = await resolveRevision(repositoryId, revision);
  const size = limitQuery(max, 500);
  const indexed = await indexedSnapshot(repositoryId, id, (tree, root) =>
    tree.directory(root, directory, size, cursor));
  if (indexed) return { revision: id, directory, treeId: null, ...indexed };
  // Only v1 trees lacking derived roots use the legacy stored tree payload.
  const tree = await cachedTree(repositoryId, id);
  const prefix = directory ? directory + "/" : "";
  const descendants = tree.entries.filter(e => e.path.startsWith(prefix));
  const children = new Map<string, { path: string; kind: "file" | "directory"; objectId?: string }>();
  for (const entry of descendants) {
    const tail = entry.path.slice(prefix.length);
    const first = tail.split("/")[0];
    const path = prefix + first;
    if (tail.includes("/")) children.set(path, { path, kind: "directory" });
    else if (!children.has(path)) children.set(path, { path, kind: "file", objectId: entry.objectId });
  }
  const sorted = [...children.values()].sort((a, b) => a.path.localeCompare(b.path));
  const page = sorted.filter(e => e.path > cursor).slice(0, size + 1);
  return { revision: id, directory, treeId: tree.treeId, entries: page.slice(0, size),
    nextCursor: page.length > size ? page[size - 1].path : null };
}

export async function resolvePath(repositoryId: string, revision: string, path: string) {
  if (!validPath(path)) throw new SourceControlError(422, "INVALID_PATH", "Invalid repository path");
  const id = await resolveRevision(repositoryId, revision);
  const indexed = await indexedSnapshot(repositoryId, id, async (tree, root) => {
    const entry = await tree.get(root, path);
    if (entry) return { revision: id, path, kind: "file" as const, objectId: entry.objectId };
    if (await tree.hasPrefix(root, path + "/")) return { revision: id, path, kind: "directory" as const };
    throw new SourceControlError(404, "PATH_NOT_FOUND", "Path does not exist at this revision");
  });
  if (indexed) return indexed;
  const tree = await cachedTree(repositoryId, id);
  const entry = tree.entries.find(e => e.path === path);
  if (entry) return { revision: id, path, kind: "file", objectId: entry.objectId };
  if (tree.entries.some(e => e.path.startsWith(path + "/"))) return { revision: id, path, kind: "directory" };
  throw new SourceControlError(404, "PATH_NOT_FOUND", "Path does not exist at this revision");
}

export async function compareQuery(repositoryId: string, from: string, to: string) {
  const [source, target] = await Promise.all([resolveRevision(repositoryId, from), resolveRevision(repositoryId, to)]);
  const [a, b] = await Promise.all([cachedTree(repositoryId, source), cachedTree(repositoryId, target)]);
  return { from: source, to: target, changes: compareEntries(a.entries, b.entries) };
}

async function verifiedBlobs(ids: string[]): Promise<Map<string, Uint8Array | null>> {
  const found = await db.sourceObject.findMany({
    where: { id: { in: [...new Set(ids)] } },
    select: { id: true, kind: true, data: true, externalId: true },
  });
  const result = new Map<string, Uint8Array | null>();
  for (const obj of found) {
    if (obj.kind !== "BLOB") throw new Error("Unexpected non-blob query object");
    if (obj.data) {
      if (objectId("BLOB", obj.data) !== obj.id) throw new Error("Corrupt content-addressed object");
      result.set(obj.id, obj.data);
      continue;
    }
    if (obj.externalId !== obj.id) throw new Error("Invalid external blob identity");
    const stored = await db.storedBlob.findFirst({ where: { id: obj.id, state: "READY" } });
    if (!stored) throw new SourceControlError(409, "OBJECT_UNAVAILABLE", "Object is not published");
    if (stored.rawBytes > 4n * 1024n * 1024n) {
      result.set(obj.id, null);
      continue;
    }
    const parts: Buffer[] = [];
    for await (const part of await verifiedBlobStream(stored)) parts.push(Buffer.from(part));
    result.set(obj.id, Buffer.concat(parts));
  }
  if (result.size !== new Set(ids).size) throw new Error("Missing object in immutable tree");
  return result;
}

function textOf(bytes: Uint8Array | null): string | null {
  if (bytes === null || bytes.includes(0)) return null;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return null; }
}

export async function diffQuery(repositoryId: string, from: string, to: string, max = 50, offset = 0) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new SourceControlError(422, "INVALID_OFFSET", "Offset must be a nonnegative integer");
  const comparison = await compareQuery(repositoryId, from, to);
  const size = limitQuery(max, 100);
  const relevant = comparison.changes.slice(offset, offset + size);
  const blobs = await verifiedBlobs(relevant.flatMap(c => [c.before, c.after].filter((x): x is string => !!x)));
  const files = relevant.map(change => {
    const before = change.before ? textOf(blobs.get(change.before)!) : "";
    const after = change.after ? textOf(blobs.get(change.after)!) : "";
    const binary = before === null || after === null;
    return { ...change, binary, ...(binary ? { patch: null, truncated: false } : textPatch(before, after)) };
  });
  return { from: comparison.from, to: comparison.to, files, totalFiles: comparison.changes.length,
    nextOffset: comparison.changes.length > offset + size ? offset + size : null };
}

type HistoryNode = { id: string; depth: number };
// Used only by the bounded rebase preview. Never load 1m IDs to reject a
// preview that supports at most 200 operations.
async function firstParentChain(repositoryId: string, revision: string, maxDepth = 201): Promise<HistoryNode[]> {
  const id = await resolveRevision(repositoryId, revision);
  return db.$queryRaw<HistoryNode[]>`
    WITH RECURSIVE first_parent(id, depth) AS (
      SELECT id, 0 FROM "SourceChangeset" WHERE id = ${id} AND "repositoryId" = ${repositoryId}::uuid
      UNION ALL
      SELECT p."parentId", f.depth + 1 FROM "SourceChangesetParent" p
        JOIN first_parent f ON p."changesetId" = f.id WHERE p.position = 0
    )
    SELECT id, depth FROM first_parent LIMIT ${maxDepth + 1}
  `;
}

export type FileHistoryEvent = {
  changesetId: string; path: string; kind: string; previousPath: string | null;
  objectId: string | null; authorId: string; message: string; createdAt: Date;
};

type FileHistoryRow = {
  changesetId: string; path: string; kind: string; previousPath: string | null;
  objectId: string | null; depth: number;
};

// A recursive first-parent walk is executed within PostgreSQL. Only relevant
// file operations (up to the caller's page limit) enter JS memory. Rename
// following resumes after the rename's depth, independent of history length.
export async function fileHistory(repositoryId: string, revision: string, path: string, followRenames = true, max = 100) {
  if (!validPath(path)) throw new SourceControlError(422, "INVALID_PATH", "Invalid repository path");
  const id = await resolveRevision(repositoryId, revision);
  const size = limitQuery(max, 1000);
  const accelerated = await indexedFileHistory(repositoryId, id, path, followRenames, size);
  if (accelerated) return accelerated;
  const events: FileHistoryRow[] = [];
  let current = path;
  let fromDepth = 0;
  let truncated = false;
  // Each rename consumes at least one event, so this loop is bounded by size.
  while (events.length <= size) {
    const limit = size + 1 - events.length;
    const candidates = await db.$queryRaw<FileHistoryRow[]>`
      WITH RECURSIVE chain(id, depth) AS (
        SELECT id, 0 FROM "SourceChangeset" WHERE id = ${id} AND "repositoryId" = ${repositoryId}::uuid
        UNION ALL SELECT p."parentId", f.depth + 1
          FROM "SourceChangesetParent" p JOIN chain f ON p."changesetId" = f.id
          WHERE p.position = 0
      )
      SELECT op."changesetId", op.path, op.kind::text AS kind,
        op."previousPath", op."objectId", chain.depth
      FROM chain JOIN "SourceFileOperation" op ON op."changesetId" = chain.id
      WHERE chain.depth >= ${fromDepth} AND op.path = ${current}
      ORDER BY chain.depth, op.position LIMIT ${limit}
    `;
    if (!candidates.length) break;
    let rename = false;
    for (const candidate of candidates) {
      events.push(candidate);
      if (events.length > size) { truncated = true; break; }
      if (followRenames && (candidate.kind === "MOVE" || candidate.kind === "RENAME") && candidate.previousPath) {
        current = candidate.previousPath;
        fromDepth = Number(candidate.depth) + 1;
        rename = true;
        break;
      }
    }
    if (truncated || !rename) break;
  }
  const selected = events.slice(0, size);
  const metadata = await db.sourceChangeset.findMany({ where: { repositoryId,
      id: { in: selected.map(e => e.changesetId) } },
    select: { id: true, authorId: true, message: true, createdAt: true } });
  const byId = new Map(metadata.map(row => [row.id, row]));
  const records: FileHistoryEvent[] = selected.map(e => {
    const meta = byId.get(e.changesetId);
    if (!meta) throw new SourceControlError(409, "CORRUPT_HISTORY", "Missing historical revision");
    return { changesetId: e.changesetId, path: e.path, kind: e.kind,
      previousPath: e.previousPath, objectId: e.objectId,
      authorId: meta.authorId, message: meta.message, createdAt: meta.createdAt };
  });
  return { revision: id, path, firstParentOnly: true, records, truncated };
}

// Path-impact search uses durable precomputed touches when available, with
// canonical operations as a correctness-preserving fallback during indexing.
export async function pathImpactQuery(repositoryId: string, revision: string, path: string, max = 100) {
  if (!validPath(path)) throw new SourceControlError(422, "INVALID_PATH", "Invalid repository path");
  const id = await resolveRevision(repositoryId, revision);
  return exactDagPathImpact(repositoryId, id, path, limitQuery(max, 1000));
}

export async function contributionImpactQuery(repositoryId: string, revision: string, max = 100, after = "") {
  if (after.length > 256) throw new SourceControlError(422, "INVALID_CURSOR", "Invalid contribution cursor");
  const id = await resolveRevision(repositoryId, revision);
  return exactDagContributions(repositoryId, id, limitQuery(max, 200), after);
}

export async function blameQuery(repositoryId: string, revision: string, path: string,
  maxHistory = 500, offset = 0, maxLines = 200) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxLines) || maxLines < 1) {
    throw new SourceControlError(422, "INVALID_PAGE", "Blame requires a valid line range");
  }
  const size = Math.min(maxLines, 500);
  const resolved = await resolveRevision(repositoryId, revision);
  await enqueueDerived(repositoryId, resolved, ["blame"]);
  const entry = await resolvePath(repositoryId, resolved, path);
  if (entry.kind !== "file" || !entry.objectId) throw new SourceControlError(422, "NOT_A_FILE", "Blame requires a file");
  // An immutable line-origin checkpoint avoids any historical file replay on a
  // warm read, including text files larger than the legacy 4 MiB blob limit.
  const indexed = await indexedBlamePage(repositoryId, entry.revision, path, entry.objectId, offset, size);
  if (indexed) return { revision: entry.revision, path, firstParentOnly: true,
    truncated: false, ...indexed };
  const object = await db.sourceObject.findFirst({ where: { id: entry.objectId },
    select: { kind: true, byteSize: true } });
  if (!object || object.kind !== "BLOB") throw new SourceControlError(409, "CORRUPT_HISTORY", "Missing indexed file object");
  // Preserve legacy cold reads only for small files with complete history.
  // Oversized inputs and completed but unavailable indexes fail explicitly.
  // A missing index is retryable; an algorithmic resource limit is not.
  if (object.byteSize > BigInt(MAX_TEXT_BYTES)) {
    throw new SourceControlError(413, "BLAME_FILE_TOO_LARGE",
      "Text file exceeds configured indexed-blame processing limit");
  }
  if (object.byteSize > 1024n * 1024n) {
    const completed = await readDerived(repositoryId, resolved, "blame");
    const provenance = completed ? await latestBlameFile(repositoryId, resolved, path) : null;
    if (completed) throw new SourceControlError(422, "BLAME_INDEX_UNAVAILABLE",
      "Blame provenance cannot be computed under the configured resource limits");
    throw new SourceControlError(503, "BLAME_INDEX_PENDING",
      "Large-file provenance is being indexed");
  }
  const history = await fileHistory(repositoryId, revision, path, true, maxHistory);
  if (history.truncated) throw new SourceControlError(503, "BLAME_INDEX_PENDING",
    "Complete line provenance is still being indexed");
  const ids = [entry.objectId, ...history.records.map(e => e.objectId).filter((id): id is string => !!id)];
  const blobs = await verifiedBlobs(ids);
  const present = textOf(blobs.get(entry.objectId)!);
  if (present === null) throw new SourceControlError(415, "BINARY_FILE", "Blame is only available for UTF-8 text files");
  const eventData = history.records.filter(e => e.objectId).map(e => ({
    changesetId: e.changesetId, content: textOf(blobs.get(e.objectId!)!),
  }));
  if (eventData.some(e => e.content === null)) throw new SourceControlError(415, "BINARY_HISTORY", "File history contains non-text content");
  const lines = blameLines(present, eventData as { changesetId: string; content: string }[]);
  return { revision: entry.revision, path, firstParentOnly: true, truncated: false,
    lines: lines.slice(offset, offset + size), totalLines: lines.length,
    nextOffset: offset + size < lines.length ? offset + size : null };
}

export async function mergeQuery(repositoryId: string, ours: string, theirs: string) {
  const [left, right] = await Promise.all([resolveRevision(repositoryId, ours), resolveRevision(repositoryId, theirs)]);
  const bases = await mergeBases(repositoryId, left, right);
  if (bases.length > 1) throw new SourceControlError(409, "MULTIPLE_MERGE_BASES", "Criss-cross history requires explicit base selection");
  const [original, oursTree, theirsTree] = await Promise.all([
    bases.length ? cachedTree(repositoryId, bases[0]) : Promise.resolve({ entries: [] as TreeEntry[] }),
    cachedTree(repositoryId, left), cachedTree(repositoryId, right),
  ]);
  const preview = mergeEntries(original.entries, oursTree.entries, theirsTree.entries);
  return { ours: left, theirs: right, mergeBases: bases, ...preview,
    clean: !preview.conflicts.length, published: false };
}

export async function rebaseQuery(repositoryId: string, tip: string, onto: string) {
  const [head, target] = await Promise.all([resolveRevision(repositoryId, tip), resolveRevision(repositoryId, onto)]);
  const bases = await mergeBases(repositoryId, head, target);
  if (bases.length !== 1) throw new SourceControlError(409, "AMBIGUOUS_BASE", "Rebase requires exactly one merge base");
  const chain = await firstParentChain(repositoryId, head);
  const end = chain.findIndex(node => node.id === bases[0]);
  if (end < 0 && chain.length > 201) throw new SourceControlError(413, "REBASE_LIMIT", "Preview supports at most 200 source changesets");
  if (end < 0) throw new SourceControlError(409, "NONLINEAR_REBASE", "Merge base is not on source first-parent history");
  if (end > 200) throw new SourceControlError(413, "REBASE_LIMIT", "Preview supports at most 200 source changesets");
  const revisionIds = chain.slice(0, end).map(n => n.id).reverse();
  const [sourceBase, targetTree] = await Promise.all([cachedTree(repositoryId, bases[0]), cachedTree(repositoryId, target)]);
  let sourceEntries = sourceBase.entries;
  let rebased = new Map(targetTree.entries.map(e => [e.path, e.objectId]));
  const conflicts: { changesetId: string; path: string; expected: string | null; actual: string | null }[] = [];
  for (const id of revisionIds) {
    const parents = await db.sourceChangesetParent.findMany({ where: { changesetId: id } });
    if (parents.length !== 1) throw new SourceControlError(409, "MERGE_REBASE_UNSUPPORTED", "Rebase of merge changesets requires an explicit strategy");
    const next = (await cachedTree(repositoryId, id)).entries;
    const operations = compareEntries(sourceEntries, next);
    for (const op of operations) {
      const oldPath = op.previousPath ?? op.path;
      const expected = sourceEntries.find(e => e.path === oldPath)?.objectId ?? null;
      const actual = rebased.get(oldPath) ?? null;
      const destinationOccupied = rebased.has(op.path) && op.previousPath !== undefined;
      if (actual !== expected || destinationOccupied) {
        conflicts.push({ changesetId: id, path: op.path, expected, actual });
        continue;
      }
      // Copies keep the source; renames remove it. Neither changes an actual ref.
      if (op.kind === "RENAME") rebased.delete(op.previousPath!);
      if (op.after) rebased.set(op.path, op.after);
      else rebased.delete(op.path);
    }
    sourceEntries = next;
  }
  const entries = [...rebased].map(([path, objectId]) => ({ path, objectId }));
  return { tip: head, onto: target, mergeBase: bases[0], replayedChangesets: revisionIds, conflicts,
    clean: conflicts.length === 0, entries: entries.sort((a, b) => a.path.localeCompare(b.path)),
    proposedTreeId: conflicts.length ? null : objectId("TREE", encodeTree(entries)), published: false };
}

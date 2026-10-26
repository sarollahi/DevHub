import { ensureIndexJob } from "../workers/query-indexer";
import { db } from "../lib/prisma";
import { validPath } from "../lib/review-logic";
import { SourceControlError, type TreeEntry } from "./contracts";
import { decodeTree, encodeTree, objectId } from "./storage";
import { getTree as readTree } from "./service";
import { verifiedBlobStream } from "../object-store/service";
import { blameLines, compareEntries, mergeEntries, textPatch } from "./query-algorithms";

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
  const value = await readTree(repositoryId, id);
  treeCache.set(key, value);
  if (treeCache.size > 24) treeCache.delete(treeCache.keys().next().value!);
  return value;
}


export async function resolveRevision(repositoryId: string, revision: string): Promise<string> {
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
  return id;
}

// PostgreSQL's recursive UNION removes already visited vertices even in wide
// merge-heavy DAGs. Edges are read from the parent table, not from file trees.
export async function ancestors(repositoryId: string, revision: string): Promise<string[]> {
  const id = await resolveRevision(repositoryId, revision);
  const rows = await db.$queryRaw<{ id: string }[]>`
    WITH RECURSIVE reachable(id) AS (
      SELECT id FROM "SourceChangeset" WHERE id = ${id} AND "repositoryId" = ${repositoryId}::uuid
      UNION
      SELECT p."parentId" FROM "SourceChangesetParent" p
        JOIN reachable r ON r.id = p."changesetId"
    )
    SELECT id FROM reachable LIMIT 100001
  `;
  if (rows.length > 100000) throw new SourceControlError(413, "HISTORY_LIMIT", "Ancestry exceeds 100,000 changesets");
  return rows.map(row => row.id);
}

export async function isAncestor(repositoryId: string, ancestor: string, descendant: string): Promise<boolean> {
  const a = await resolveRevision(repositoryId, ancestor);
  return (await ancestors(repositoryId, descendant)).includes(a);
}

export async function mergeBases(repositoryId: string, leftRevision: string, rightRevision: string) {
  const [left, right] = await Promise.all([ancestors(repositoryId, leftRevision), ancestors(repositoryId, rightRevision)]);
  const leftSet = new Set(left);
  const shared = new Set(right.filter(id => leftSet.has(id)));
  if (!shared.size) return [];
  // Shared is ancestry-closed. A shared parent with a shared child cannot
  // be a lowest common ancestor; this also preserves multiple criss-cross bases.
  const bases = new Set(shared);
  for (const group of chunks([...shared])) {
    const edges = await db.sourceChangesetParent.findMany({
      where: { changesetId: { in: group } }, select: { parentId: true },
    });
    for (const edge of edges) if (shared.has(edge.parentId)) bases.delete(edge.parentId);
  }
  return [...bases].sort();
}

export async function ancestryQuery(repositoryId: string, revision: string, other?: string, max = 100) {
  const resolved = await resolveRevision(repositoryId, revision);
  const nodes = await ancestors(repositoryId, resolved);
  const common = other ? await mergeBases(repositoryId, resolved, other) : [];
  return { revision: resolved, ancestorCount: nodes.length - 1, ancestors: nodes.slice(0, limitQuery(max, 1000)),
    truncated: nodes.length > limitQuery(max, 1000), mergeBases: common };
}

export async function treeQuery(repositoryId: string, revision: string, directory = "", max = 200, cursor = "") {
  if (directory && !validPath(directory)) throw new SourceControlError(422, "INVALID_PATH", "Invalid repository path");
  const id = await resolveRevision(repositoryId, revision);
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
  const size = limitQuery(max, 500);
  const page = sorted.filter(e => e.path > cursor).slice(0, size + 1);
  return { revision: id, directory, treeId: tree.treeId, entries: page.slice(0, size),
    nextCursor: page.length > size ? page[size - 1].path : null };
}

export async function resolvePath(repositoryId: string, revision: string, path: string) {
  if (!validPath(path)) throw new SourceControlError(422, "INVALID_PATH", "Invalid repository path");
  const id = await resolveRevision(repositoryId, revision);
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
async function firstParentChain(repositoryId: string, revision: string): Promise<HistoryNode[]> {
  const id = await resolveRevision(repositoryId, revision);
  const rows = await db.$queryRaw<HistoryNode[]>`
    WITH RECURSIVE first_parent(id, depth) AS (
      SELECT id, 0 FROM "SourceChangeset" WHERE id = ${id} AND "repositoryId" = ${repositoryId}::uuid
      UNION ALL
      SELECT p."parentId", f.depth + 1 FROM "SourceChangesetParent" p
        JOIN first_parent f ON p."changesetId" = f.id WHERE p.position = 0
    )
    SELECT id, depth FROM first_parent LIMIT 100001
  `;
  if (rows.length > 100000) throw new SourceControlError(413, "HISTORY_LIMIT", "First-parent history exceeds 100,000 changesets");
  return rows;
}

export type FileHistoryEvent = {
  changesetId: string; path: string; kind: string; previousPath: string | null;
  objectId: string | null; authorId: string; message: string; createdAt: Date;
};

export async function fileHistory(repositoryId: string, revision: string, path: string, followRenames = true, max = 100) {
  if (!validPath(path)) throw new SourceControlError(422, "INVALID_PATH", "Invalid repository path");
  const id = await resolveRevision(repositoryId, revision);
  const chain = await firstParentChain(repositoryId, id);
  const index = new Map(chain.map((node, i) => [node.id, i]));
  const events: { changesetId: string; path: string; kind: string; previousPath: string | null; objectId: string | null }[] = [];
  let current = path;
  let offset = 0;
  while (offset < chain.length) {
    const candidates: typeof events = [];
    for (const batch of chunks(chain.slice(offset).map(node => node.id))) {
      const matches = await db.sourceFileOperation.findMany({ where: { changesetId: { in: batch },
        OR: [{ path: current }, { previousPath: current }] },
        select: { changesetId: true, path: true, kind: true, previousPath: true, objectId: true } });
      candidates.push(...matches);
    }
    candidates.sort((a, b) => index.get(a.changesetId)! - index.get(b.changesetId)!);
    let renamed = false;
    for (const change of candidates) {
      const position = index.get(change.changesetId)!;
      if (position < offset) continue;
      if (change.path !== current) continue; // MOVE source is represented at destination.
      events.push(change);
      if (followRenames && (change.kind === "MOVE" || change.kind === "RENAME") && change.previousPath) {
        current = change.previousPath;
        offset = position + 1;
        renamed = true;
        break;
      }
    }
    if (!renamed) break;
  }
  const selected = events.slice(0, limitQuery(max, 1000));
  const metadata = await db.sourceChangeset.findMany({ where: { repositoryId, id: { in: selected.map(e => e.changesetId) } },
    select: { id: true, authorId: true, message: true, createdAt: true } });
  const byId = new Map(metadata.map(row => [row.id, row]));
  const records: FileHistoryEvent[] = selected.map(e => {
    const meta = byId.get(e.changesetId)!;
    return { ...e, authorId: meta.authorId, message: meta.message, createdAt: meta.createdAt };
  });
  return { revision: id, path, firstParentOnly: true, records, truncated: events.length > selected.length };
}

// Path-impact search uses durable precomputed touches when available, with
// canonical operations as a correctness-preserving fallback during indexing.
export async function pathImpactQuery(repositoryId: string, revision: string, path: string, max = 100) {
  if (!validPath(path)) throw new SourceControlError(422, "INVALID_PATH", "Invalid repository path");
  const id = await resolveRevision(repositoryId, revision);
  const reachable = await ancestors(repositoryId, id);
  const seen = new Set<string>();
  const records: { changesetId: string; path: string; operationPath: string; role: string }[] = [];
  const add = (changesetId: string, operationPath: string, role: string) => {
    const key = changesetId + ":" + operationPath + ":" + role;
    if (!seen.has(key)) { seen.add(key); records.push({ changesetId, path, operationPath, role }); }
  };
  for (const batch of chunks(reachable)) {
    const complete = await db.sourceQueryIndexJob.findMany({
      where: { changesetId: { in: batch }, state: "SUCCEEDED" }, select: { changesetId: true },
    });
    const indexedIds = complete.map(e => e.changesetId);
    const indexed = new Set(indexedIds);
    if (indexedIds.length) {
      const touches = await db.sourceQueryPathTouch.findMany({ where: {
        changesetId: { in: indexedIds }, path,
      }, select: { changesetId: true, operationPath: true, role: true } });
      for (const touch of touches) add(touch.changesetId, touch.operationPath, touch.role);
    }
    const missing = batch.filter(cid => !indexed.has(cid));
    if (missing.length) {
      const raw = await db.sourceFileOperation.findMany({ where: {
        changesetId: { in: missing }, OR: [{ path }, { previousPath: path }],
      }, select: { changesetId: true, path: true, previousPath: true } });
      for (const op of raw) {
        if (op.path === path) add(op.changesetId, op.path, "destination");
        if (op.previousPath === path) add(op.changesetId, op.path, "source");
      }
    }
  }
  const order = new Map(reachable.map((value, index) => [value, index]));
  records.sort((a, b) => order.get(a.changesetId)! - order.get(b.changesetId)!);
  const size = limitQuery(max, 1000);
  return { revision: id, path, records: records.slice(0, size), total: records.length,
    truncated: records.length > size };
}

export async function blameQuery(repositoryId: string, revision: string, path: string, maxHistory = 500) {
  const entry = await resolvePath(repositoryId, revision, path);
  if (entry.kind !== "file" || !entry.objectId) throw new SourceControlError(422, "NOT_A_FILE", "Blame requires a file");
  const history = await fileHistory(repositoryId, revision, path, true, maxHistory);
  const ids = [entry.objectId, ...history.records.map(e => e.objectId).filter((id): id is string => !!id)];
  const blobs = await verifiedBlobs(ids);
  const present = textOf(blobs.get(entry.objectId)!);
  if (present === null) throw new SourceControlError(415, "BINARY_FILE", "Blame is only available for UTF-8 text files");
  const eventData = history.records.filter(e => e.objectId).map(e => ({
    changesetId: e.changesetId, content: textOf(blobs.get(e.objectId!)!),
  }));
  if (eventData.some(e => e.content === null)) throw new SourceControlError(415, "BINARY_HISTORY", "File history contains non-text content");
  return { revision: entry.revision, path, firstParentOnly: true, truncated: history.truncated,
    lines: blameLines(present, eventData as { changesetId: string; content: string }[]) };
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

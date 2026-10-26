import { db } from "../lib/prisma";
import { validPath } from "../lib/review-logic";
import { SourceControlError, type TreeEntry } from "./contracts";
import { decodeTree, encodeTree, objectId } from "./storage";
import { getTree } from "./service";
import { blameLines, compareEntries, mergeEntries, textPatch } from "./query-algorithms";

const digest = /^[a-f0-9]{64}$/;
const chunks = <T>(values: T[], size = 800): T[][] =>
  Array.from({ length: Math.ceil(values.length / size) }, (_, i) => values.slice(i * size, (i + 1) * size));
const limitQuery = (number: number, max = 200) => Number.isSafeInteger(number) && number > 0 ? Math.min(max, number) : 50;

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
  const tree = await getTree(repositoryId, id);
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
  const tree = await getTree(repositoryId, id);
  const entry = tree.entries.find(e => e.path === path);
  if (entry) return { revision: id, path, kind: "file", objectId: entry.objectId };
  if (tree.entries.some(e => e.path.startsWith(path + "/"))) return { revision: id, path, kind: "directory" };
  throw new SourceControlError(404, "PATH_NOT_FOUND", "Path does not exist at this revision");
}

export async function compareQuery(repositoryId: string, from: string, to: string) {
  const [source, target] = await Promise.all([resolveRevision(repositoryId, from), resolveRevision(repositoryId, to)]);
  const [a, b] = await Promise.all([getTree(repositoryId, source), getTree(repositoryId, target)]);
  return { from: source, to: target, changes: compareEntries(a.entries, b.entries) };
}

async function verifiedBlobs(ids: string[]): Promise<Map<string, Uint8Array>> {
  const found = await db.sourceObject.findMany({ where: { id: { in: [...new Set(ids)] } }, select: { id: true, kind: true, data: true } });
  const result = new Map<string, Uint8Array>();
  for (const obj of found) {
    if (obj.kind !== "BLOB" || objectId("BLOB", obj.data) !== obj.id) throw new Error("Corrupt or unexpected content-addressed object");
    result.set(obj.id, obj.data);
  }
  if (result.size !== new Set(ids).size) throw new Error("Missing object referenced by immutable tree");
  return result;
}

function textOf(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return null; }
}

export async function diffQuery(repositoryId: string, from: string, to: string, max = 50) {
  const comparison = await compareQuery(repositoryId, from, to);
  const size = limitQuery(max, 100);
  const relevant = comparison.changes.slice(0, size);
  const blobs = await verifiedBlobs(relevant.flatMap(c => [c.before, c.after].filter((x): x is string => !!x)));
  const files = relevant.map(change => {
    const before = change.before ? textOf(blobs.get(change.before)!) : "";
    const after = change.after ? textOf(blobs.get(change.after)!) : "";
    const binary = before === null || after === null;
    return { ...change, binary, ...(binary ? { patch: null, truncated: false } : textPatch(before, after)) };
  });
  return { from: comparison.from, to: comparison.to, files, totalFiles: comparison.changes.length,
    nextOffset: comparison.changes.length > size ? size : null };
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
      if (followRenames && change.kind === "MOVE" && change.previousPath) {
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
    bases.length ? getTree(repositoryId, bases[0]) : Promise.resolve({ entries: [] as TreeEntry[] }),
    getTree(repositoryId, left), getTree(repositoryId, right),
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
  const [sourceBase, targetTree] = await Promise.all([getTree(repositoryId, bases[0]), getTree(repositoryId, target)]);
  let sourceEntries = sourceBase.entries;
  let rebased = new Map(targetTree.entries.map(e => [e.path, e.objectId]));
  const conflicts: { changesetId: string; path: string; expected: string | null; actual: string | null }[] = [];
  for (const id of revisionIds) {
    const parents = await db.sourceChangesetParent.findMany({ where: { changesetId: id } });
    if (parents.length !== 1) throw new SourceControlError(409, "MERGE_REBASE_UNSUPPORTED", "Rebase of merge changesets requires an explicit strategy");
    const next = (await getTree(repositoryId, id)).entries;
    const operations = compareEntries(sourceEntries, next);
    for (const op of operations) {
      const oldPath = op.previousPath ?? op.path;
      const expected = sourceEntries.find(e => e.path === oldPath)?.objectId ?? null;
      const actual = rebased.get(oldPath) ?? null;
      if (actual !== expected || (op.previousPath && rebased.has(op.path))) {
        conflicts.push({ changesetId: id, path: op.path, expected, actual });
        continue;
      }
      if (op.previousPath) rebased.delete(op.previousPath);
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

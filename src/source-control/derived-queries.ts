import { db } from "../lib/prisma";
import { validPath } from "../lib/review-logic";
import { SourceControlError } from "./contracts";
import { DERIVED_VERSION, enqueueDerived, readDerived } from "./derived-index";

// Never dereference a derived row before the caller has authorized and resolved
// the repository/revision. These helpers deliberately do not expose HTTP routes.
export type Summary = { firstParentDepth: number; generation: number; linear: boolean; parentCount: number; nearestMerge: string | null };
type Posting = { changesetId: string; position: number; kind: string; path: string;
  previousPath: string | null; objectId: string | null; generation: number };
type IndexedEvent = { changesetId: string; path: string; kind: string; previousPath: string | null;
  objectId: string | null; authorId: string; message: string; createdAt: Date };
function safeInt(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("CORRUPT_DERIVED_INDEX");
  return value;
}
export class IndexedWalk {
  private summaries = new Map<string, Summary | null>();
  private jumps = new Map<string, string | null>();
  constructor(private repositoryId: string) {}
  async summary(id: string): Promise<Summary | null> {
    if (this.summaries.has(id)) return this.summaries.get(id)!;
    const value = await readDerived(this.repositoryId, id, "ancestry");
    const result = value ? { firstParentDepth: safeInt(value.firstParentDepth),
      generation: safeInt(value.generation), linear: value.linear === true,
      parentCount: safeInt(value.parentCount), nearestMerge: typeof value.nearestMerge === "string" ? value.nearestMerge : null } : null;
    this.summaries.set(id, result);
    return result;
  }
  async jump(id: string, level: number): Promise<string | null> {
    const key = id + ":" + level;
    if (this.jumps.has(key)) return this.jumps.get(key)!;
    const row = await db.sourceDerivedJump.findUnique({
      where: { changesetId_version_level: { changesetId: id, version: DERIVED_VERSION, level } },
      select: { repositoryId: true, ancestorId: true },
    });
    if (row && row.repositoryId !== this.repositoryId) throw new Error("CROSS_REPOSITORY_JUMP");
    const value = row?.ancestorId ?? null;
    this.jumps.set(key, value);
    return value;
  }
  async lift(id: string, steps: number): Promise<string | null> {
    if (!Number.isSafeInteger(steps) || steps < 0) throw new Error("INVALID_INDEX_STEP");
    let current: string | null = id;
    while (current && steps > 0) {
      const level = Math.floor(Math.log2(steps));
      current = await this.jump(current, level);
      steps -= 2 ** level;
    }
    return current;
  }
  async onFirstParentChain(head: string, ancestor: string): Promise<boolean> {
    const [h, a] = await Promise.all([this.summary(head), this.summary(ancestor)]);
    if (!h || !a || a.firstParentDepth > h.firstParentDepth) return false;
    return (await this.lift(head, h.firstParentDepth - a.firstParentDepth)) === ancestor;
  }
}

export type IndexedSpine = { tip: string; tail: string; topDepth: number; bottomDepth: number };

/** First-parent segments joined only at merge vertices.
 * Each segment covers every canonical first-parent revision in [tail, tip].
 * Merge side parents are followed separately, including independent roots.
 */
export async function indexedDagSpines(walk: IndexedWalk, repositoryId: string, head: string,
  maxSpines = 1024): Promise<IndexedSpine[] | null> {
  const pending = [head], visited = new Set<string>(), result: IndexedSpine[] = [];
  while (pending.length) {
    const tip = pending.pop()!;
    if (visited.has(tip)) continue;
    visited.add(tip);
    if (result.length >= maxSpines) return null;
    const summary = await walk.summary(tip);
    if (!summary) return null;
    const tail = summary.nearestMerge ?? await walk.lift(tip, summary.firstParentDepth);
    if (!tail) return null;
    const end = await walk.summary(tail);
    if (!end || end.firstParentDepth > summary.firstParentDepth) throw new Error("CORRUPT_DAG_INDEX");
    if ((await walk.lift(tip, summary.firstParentDepth - end.firstParentDepth)) !== tail) {
      throw new Error("CORRUPT_DAG_INDEX");
    }
    result.push({ tip, tail, topDepth: summary.firstParentDepth, bottomDepth: end.firstParentDepth });
    if (!summary.nearestMerge) continue;
    const edges = await db.sourceChangesetParent.findMany({ where: { changesetId: tail },
      orderBy: { position: "asc" }, select: { parentId: true } });
    if (edges.length !== end.parentCount || edges.length < 2) throw new Error("CORRUPT_DAG_INDEX");
    for (const edge of edges) {
      if (!(await walk.summary(edge.parentId))) return null;
      pending.push(edge.parentId);
    }
  }
  return result;
}

/** A first-parent LCA is valid even if either changeset has merge parents. */
export async function indexedFirstParentLca(walk: IndexedWalk, a: string, b: string): Promise<string | null> {
  const [left, right] = await Promise.all([walk.summary(a), walk.summary(b)]);
  if (!left || !right) return null;
  let x = a, y = b;
  if (left.firstParentDepth > right.firstParentDepth) {
    const ancestor = await walk.lift(a, left.firstParentDepth - right.firstParentDepth);
    if (!ancestor) return null;
    x = ancestor;
  } else if (right.firstParentDepth > left.firstParentDepth) {
    const ancestor = await walk.lift(b, right.firstParentDepth - left.firstParentDepth);
    if (!ancestor) return null;
    y = ancestor;
  }
  if (x === y) return x;
  for (let bit = Math.floor(Math.log2(Math.min(left.firstParentDepth, right.firstParentDepth) + 1));
       bit >= 0; bit--) {
    const [px, py] = await Promise.all([walk.jump(x, bit), walk.jump(y, bit)]);
    if (px && py && px !== py) { x = px; y = py; }
  }
  const [px, py] = await Promise.all([walk.jump(x, 0), walk.jump(y, 0)]);
  return px && px === py ? px : null;
}

export async function indexedDagIsAncestor(repositoryId: string, ancestor: string, descendant: string,
  walk = new IndexedWalk(repositoryId)): Promise<boolean | null> {
  if (ancestor === descendant) return true;
  const target = await walk.summary(ancestor);
  if (!target) return null;
  const spines = await indexedDagSpines(walk, repositoryId, descendant);
  if (!spines) return null;
  for (const spine of spines) {
    if (target.firstParentDepth < spine.bottomDepth || target.firstParentDepth > spine.topDepth) continue;
    const aligned = await walk.lift(spine.tip, spine.topDepth - target.firstParentDepth);
    if (aligned === ancestor) return true;
  }
  return false;
}

/** All lowest common ancestors, including criss-cross DAGs with multiple bases.
 * Candidate intersections come from compressed first-parent spines. Every
 * candidate is checked for reachability before eliminating non-lowest bases.
 * Pathological very-wide DAGs use an exact iterative SQL staging algorithm,
 * never repeated recursive SQL walks.
 */
export async function indexedDagMergeBases(repositoryId: string, left: string, right: string): Promise<string[] | null> {
  const walk = new IndexedWalk(repositoryId);
  const [a, b] = await Promise.all([
    indexedDagSpines(walk, repositoryId, left, 256),
    indexedDagSpines(walk, repositoryId, right, 256),
  ]);
  if (!a || !b || a.length * b.length > 1024) return null;
  const candidates = new Set<string>();
  for (const lhs of a) for (const rhs of b) {
    const shared = await indexedFirstParentLca(walk, lhs.tip, rhs.tip);
    if (!shared) continue;
    const depth = (await walk.summary(shared))?.firstParentDepth;
    if (depth === undefined) return null;
    if (depth >= lhs.bottomDepth && depth >= rhs.bottomDepth) candidates.add(shared);
  }
  const ids = [...candidates];
  const lowest = [];
  for (const candidate of ids) {
    let overshadowed = false;
    for (const other of ids) {
      if (candidate === other) continue;
      const reachable = await indexedDagIsAncestor(repositoryId, candidate, other, walk);
      if (reachable === null) return null;
      if (reachable) { overshadowed = true; break; }
    }
    if (!overshadowed) lowest.push(candidate);
  }
  return lowest.sort();
}

export async function indexedLinearAncestry(repositoryId: string, revision: string, max: number) {
  const walk = new IndexedWalk(repositoryId);
  const summary = await walk.summary(revision);
  if (!summary) { await enqueueDerived(repositoryId, revision, ["ancestry"]); return null; }
  if (!summary.linear) return null; // merge DAGs require the complete exact graph
  const size = Math.max(1, Math.min(1000, max));
  const ids = [revision];
  while (ids.length < size) {
    const parent = await walk.jump(ids[ids.length - 1], 0);
    if (!parent) break;
    ids.push(parent);
  }
  return { revision, ancestorCount: summary.firstParentDepth, ancestors: ids,
    truncated: summary.firstParentDepth + 1 > size, mergeBases: [] as string[] };
}
export async function indexedLinearMergeBases(repositoryId: string, left: string, right: string): Promise<string[] | null> {
  const walk = new IndexedWalk(repositoryId);
  const [a, b] = await Promise.all([walk.summary(left), walk.summary(right)]);
  if (!a || !b || !a.linear || !b.linear) return null;
  let lhs = left; let rhs = right;
  if (a.firstParentDepth > b.firstParentDepth) {
    lhs = (await walk.lift(lhs, a.firstParentDepth - b.firstParentDepth)) ?? "";
  } else if (b.firstParentDepth > a.firstParentDepth) {
    rhs = (await walk.lift(rhs, b.firstParentDepth - a.firstParentDepth)) ?? "";
  }
  if (!lhs || !rhs) return [];
  if (lhs === rhs) return [lhs];
  const maximum = Math.floor(Math.log2(Math.min(a.firstParentDepth, b.firstParentDepth) + 1));
  for (let level = maximum; level >= 0; level--) {
    const [l, r] = await Promise.all([walk.jump(lhs, level), walk.jump(rhs, level)]);
    if (l && r && l !== r) { lhs = l; rhs = r; }
  }
  const [l, r] = await Promise.all([walk.jump(lhs, 0), walk.jump(rhs, 0)]);
  return l && l === r ? [l] : [];
}

// Revision-specific, exact first-parent history over sparse path postings.
// A path candidate is accepted only after first-parent ancestry verification.
// Cold, version-obsolete, corrupt or truncated indexes cannot silently change
// results: return null and let the canonical query implementation take over.
export async function indexedFileHistory(
  repositoryId: string, revision: string, path: string, followRenames: boolean, max: number,
): Promise<{ revision: string; path: string; firstParentOnly: true; records: IndexedEvent[]; truncated: boolean } | null> {
  if (!validPath(path)) throw new SourceControlError(422, "INVALID_PATH", "Invalid path");
  const walk = new IndexedWalk(repositoryId);
  const head = await walk.summary(revision);
  const available = await readDerived(repositoryId, revision, "history");
  if (!head || !available) {
    await enqueueDerived(repositoryId, revision, ["ancestry", "history"]);
    return null;
  }
  const size = Math.max(1, Math.min(1000, max));
  const selected: Posting[] = [];
  let currentPath = path;
  let scope: string | null = revision;
  let examined = 0;
  const scanLimit = 20_000;
  while (scope && selected.length <= size && examined < scanLimit) {
    const generation = (await walk.summary(scope))?.generation;
    if (generation === undefined) return null;
    let cursor: { generation: number; changesetId: string } | null = null;
    let renamed = false;
    while (scope && selected.length <= size && examined < scanLimit) {
      const extra: object = cursor ? {
        OR: [{ generation: { lt: cursor.generation } },
          { generation: cursor.generation, changesetId: { lt: cursor.changesetId } }],
      } : {};
      const batch = await db.sourceDerivedPathEvent.findMany({
        where: { repositoryId, version: DERIVED_VERSION, path: currentPath, role: "destination",
          generation: { lte: generation }, ...extra },
        orderBy: [{ generation: "desc" }, { changesetId: "desc" }],
        take: 128,
      });
      if (!batch.length) { scope = null; break; }
      for (const event of batch) {
        examined++;
        if (!scope) break;
        if (!(await walk.onFirstParentChain(scope, event.changesetId))) continue;
        // Every posting is published with a SUCCEEDED history index. Parent-
        // dependent scheduling guarantees no gaps before this revision.
        selected.push({ changesetId: event.changesetId, position: event.position,
          path: event.path, kind: event.kind, previousPath: event.previousPath,
          objectId: event.objectId, generation: event.generation });
        scope = await walk.jump(event.changesetId, 0);
        if (followRenames && ["RENAME", "MOVE"].includes(event.kind) && event.previousPath) {
          currentPath = event.previousPath;
          renamed = true;
          break;
        }
        if (selected.length > size) break;
      }
      if (renamed || selected.length > size || !scope) break;
      const tail = batch[batch.length - 1];
      cursor = { generation: tail.generation, changesetId: tail.changesetId };
      if (batch.length < 128) { scope = null; break; }
    }
    if (!renamed) break;
  }
  if (examined >= scanLimit) return null; // canonical fallback, not partial data
  const records = selected.slice(0, size);
  const info = await db.sourceChangeset.findMany({ where: {
    repositoryId, id: { in: records.map(r => r.changesetId) },
  }, select: { id: true, authorId: true, message: true, createdAt: true } });
  const byId = new Map(info.map(x => [x.id, x]));
  return { revision, path, firstParentOnly: true, truncated: selected.length > size,
    records: records.map(row => {
      const meta = byId.get(row.changesetId);
      if (!meta) throw new Error("CORRUPT_HISTORY");
      return { changesetId: row.changesetId, path: row.path, kind: row.kind,
        previousPath: row.previousPath, objectId: row.objectId,
        authorId: meta.authorId, message: meta.message, createdAt: meta.createdAt };
    }),
  };
}

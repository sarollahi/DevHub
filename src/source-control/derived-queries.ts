import { db } from "../lib/prisma";
import { validPath } from "../lib/review-logic";
import { SourceControlError } from "./contracts";
import { DERIVED_VERSION, enqueueDerived, readDerived } from "./derived-index";

// Never dereference a derived row before the caller has authorized and resolved
// the repository/revision. These helpers deliberately do not expose HTTP routes.
type Summary = { firstParentDepth: number; generation: number; linear: boolean };
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
      generation: safeInt(value.generation), linear: value.linear === true } : null;
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

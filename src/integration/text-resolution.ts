import { matchingLines, linesOf } from "../source-control/query-algorithms";
import { db } from "../lib/prisma";
import { verifyAndReadBlob } from "../source-control/git-import-blobs";
import { stageCanonicalBlob } from "../source-control/canonical";
import type { SourceActor } from "../source-control/contracts";
import type { Conflict, FileEntry } from "./plan";

type Hunk = { start: number; end: number; replacement: string[] };
const sameLines = (a: string[], b: string[]) =>
  a.length === b.length && a.every((line, i) => line === b[i]);

function hunks(base: string[], next: string[]): Hunk[] | null {
  const pairs = matchingLines(base, next, 1_000_000);
  if (!pairs) return null;
  const result: Hunk[] = [];
  let old = 0, current = 0;
  for (const [b, n] of [...pairs, [base.length, next.length] as [number, number]]) {
    if (b !== old || n !== current) {
      result.push({ start: old, end: b, replacement: next.slice(current, n) });
    }
    old = b + 1;
    current = n + 1;
  }
  return result;
}
function overlap(a: Hunk, b: Hunk): boolean {
  // Insertion on the edge of a replacement is intentionally ambiguous.
  if (a.start === a.end) return b.start <= a.start && a.start <= b.end;
  if (b.start === b.end) return a.start <= b.start && b.start <= a.end;
  return a.start < b.end && b.start < a.end;
}

/** Merge only provably independent line edits; ambiguous edits are hard conflicts. */
export function mergeIndependentText(base: string, target: string, incoming: string): string | null {
  const origin = linesOf(base), ours = linesOf(target), theirs = linesOf(incoming);
  if (origin.length > 1500 || ours.length > 1500 || theirs.length > 1500) return null;
  const left = hunks(origin, ours), right = hunks(origin, theirs);
  if (!left || !right) return null;
  const combined: Hunk[] = [...left];
  for (const next of right) {
    const collisions = left.filter(h => overlap(h, next));
    if (collisions.length) {
      if (collisions.length === 1 && collisions[0].start === next.start &&
        collisions[0].end === next.end && sameLines(collisions[0].replacement, next.replacement)) continue;
      return null;
    }
    combined.push(next);
  }
  combined.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: string[] = [];
  let cursor = 0;
  for (const h of combined) {
    if (h.start < cursor) return null;
    merged.push(...origin.slice(cursor, h.start), ...h.replacement);
    cursor = h.end;
  }
  merged.push(...origin.slice(cursor));
  return merged.join("");
}

const LIMIT = 128 * 1024;
function textual(bytes: Buffer): string | null {
  if (bytes.byteLength > LIMIT || bytes.includes(0)) return null;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return null; }
}

/** Only contents from authoritative, same-repository immutable snapshots are candidates. */
export async function resolveTextConflicts(
  repositoryId: string, actor: SourceActor, conflicts: Conflict[],
): Promise<Map<string, FileEntry>> {
  const result = new Map<string, FileEntry>();
  if (conflicts.length > 32) return result;
  const eligible = conflicts.filter(c => c.code === "EDIT_CONFLICT" &&
    c.base && c.target && c.incoming &&
    c.base.mode !== "120000" && c.target.mode !== "120000" && c.incoming.mode !== "120000" &&
    (c.base.mode ?? "100644") === (c.target.mode ?? "100644") &&
    (c.base.mode ?? "100644") === (c.incoming.mode ?? "100644"));
  const hashes = [...new Set(eligible.flatMap(c => [c.base!.objectId, c.target!.objectId, c.incoming!.objectId]))];
  if (!hashes.length) return result;
  const objects = await db.sourceObject.findMany({ where: { id: { in: hashes }, kind: "BLOB" },
    select: { id: true, byteSize: true } });
  const sizes = new Map(objects.map(x => [x.id, x.byteSize]));
  for (const c of eligible) {
    const ids = [c.base!.objectId, c.target!.objectId, c.incoming!.objectId];
    if (ids.some(id => !sizes.has(id) || sizes.get(id)! > BigInt(LIMIT))) continue;
    const chunks = await Promise.all(ids.map(id => verifyAndReadBlob(null, id, LIMIT + 1)));
    const texts = chunks.map(textual);
    if (texts.some(t => t === null)) continue;
    const merged = mergeIndependentText(texts[0]!, texts[1]!, texts[2]!);
    if (merged === null || Buffer.byteLength(merged) > LIMIT) continue;
    const object = await stageCanonicalBlob(repositoryId, actor, Buffer.from(merged).toString("base64"));
    result.set(c.path, { path: c.path, objectId: object.id, mode: c.target!.mode ?? "100644" });
  }
  return result;
}

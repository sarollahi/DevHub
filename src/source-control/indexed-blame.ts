import { db } from "../lib/prisma";
import { verifiedBlobStream } from "../object-store/service";
import { linesOf, matchingLines, matchingLinesLarge } from "./query-algorithms";
import { objectId, decodeTree } from "./storage";
import { SnapshotTree } from "./snapshot-tree";
import { DERIVED_VERSION, enqueueDerived, readDerived, checksum } from "./derived-index";
import { IndexedWalk } from "./derived-queries";

export const MAX_TEXT_BYTES = 16 * 1024 * 1024;
const MAX_LINES = 250_000;
const MAX_INDEXED_FILES = 128;
const MAX_TOTAL_LINES = 500_000;
type Span = [number, number, string];
type State = { changesetId: string; version: number; position: number; path: string;
  repositoryId: string; generation: number; objectId: string;
  state: string; lineCount: number; spans: unknown; checksum: string | null };
type File = { repositoryId: string; changesetId: string; version: number; position: number;
  path: string; generation: number; objectId: string; state: string; lineCount: number;
  spans: Span[] | null; checksum: string | null };
export function compressOrigins(origins: string[]): Span[] {
  const spans: Span[] = [];
  for (let line = 0; line < origins.length; line++) {
    const prior = spans[spans.length - 1];
    if (prior && prior[2] === origins[line]) prior[1] = line + 1;
    else spans.push([line, line + 1, origins[line]]);
  }
  return spans;
}
export function expandOrigins(spans: unknown, length: number): string[] {
  if (!Array.isArray(spans) || !Number.isSafeInteger(length) || length < 0 || length > MAX_LINES) {
    throw new Error("CORRUPT_BLAME_INDEX");
  }
  const origins: string[] = [];
  for (const span of spans) {
    if (!Array.isArray(span) || span.length !== 3 || span[0] !== origins.length ||
        !Number.isSafeInteger(span[1]) || span[1] <= span[0] || span[1] > length ||
        typeof span[2] !== "string" || !/^[a-f0-9]{64}$/.test(span[2])) {
      throw new Error("CORRUPT_BLAME_INDEX");
    }
    for (let n = span[0]; n < span[1]; n++) origins.push(span[2]);
  }
  if (origins.length !== length) throw new Error("CORRUPT_BLAME_INDEX");
  return origins;
}
async function verifiedText(id: string): Promise<string | null> {
  const obj = await db.sourceObject.findUnique({ where: { id },
    select: { kind: true, data: true, externalId: true, byteSize: true } });
  if (!obj || obj.kind !== "BLOB") throw new Error("CORRUPT_SOURCE_OBJECT");
  if (obj.byteSize > BigInt(MAX_TEXT_BYTES)) return null;
  let bytes: Uint8Array;
  if (obj.data) {
    bytes = obj.data;
  } else {
    if (obj.externalId !== id) throw new Error("CORRUPT_SOURCE_OBJECT");
    const stored = await db.storedBlob.findFirst({ where: { id, state: "READY" } });
    if (!stored || stored.rawBytes !== obj.byteSize) throw new Error("CORRUPT_SOURCE_OBJECT");
    const parts: Buffer[] = [];
    let length = 0;
    for await (const part of await verifiedBlobStream(stored)) {
      length += part.length;
      if (length > MAX_TEXT_BYTES) return null;
      parts.push(Buffer.from(part));
    }
    bytes = Buffer.concat(parts);
  }
  if (bytes.byteLength !== Number(obj.byteSize) || objectId("BLOB", bytes) !== id) {
    throw new Error("CORRUPT_SOURCE_OBJECT");
  }
  if (bytes.includes(0)) return null;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return null; }
}
async function currentObject(repositoryId: string, revision: string, path: string): Promise<string | null> {
  const root = await db.sourceSnapshotRoot.findFirst({ where: { repositoryId, changesetId: revision },
    select: { rootId: true } });
  if (root) return (await new SnapshotTree(db).get(root.rootId, path))?.objectId ?? null;
  // Only legacy v1 immutable TREE anchors use a full-tree lookup. New v2
  // changesets must have a radix root or remain UNAVAILABLE.
  const change = await db.sourceChangeset.findFirst({ where: { repositoryId, id: revision },
    select: { treeId: true } });
  if (!change?.treeId) return null;
  const obj = await db.sourceObject.findFirst({ where: { id: change.treeId },
    select: { data: true, kind: true } });
  if (!obj?.data || obj.kind !== "TREE") throw new Error("CORRUPT_LEGACY_TREE");
  return decodeTree(obj.data, change.treeId).find(e => e.path === path)?.objectId ?? null;
}

// Lookups are path-index scans plus exact first-parent checks, never unbounded
// recursive SQL walks or whole-repository path maps.
export async function latestBlameFile(repositoryId: string, revision: string, path: string,
  walk = new IndexedWalk(repositoryId)): Promise<State | null> {
  const head = await walk.summary(revision);
  if (!head) return null;
  let cursor: { generation: number; changesetId: string } | null = null;
  let scanned = 0;
  while (scanned < 20_000) {
    const extra: object = cursor ? { OR: [
      { generation: { lt: cursor.generation } },
      { generation: cursor.generation, changesetId: { lt: cursor.changesetId } },
    ] } : {};
    const batch = await db.sourceDerivedBlameFile.findMany({ where: {
      repositoryId, version: DERIVED_VERSION, path, generation: { lte: head.generation }, ...extra,
    }, orderBy: [{ generation: "desc" }, { changesetId: "desc" }], take: 128 });
    if (!batch.length) return null;
    for (const row of batch) {
      scanned++;
      if (await walk.onFirstParentChain(revision, row.changesetId)) return row;
    }
    if (batch.length < 128) return null;
    const last = batch[batch.length - 1];
    cursor = { generation: last.generation, changesetId: last.changesetId };
  }
  return null;
}
export async function computeBlameFiles(change: {
  id: string; repositoryId: string;
  parents: { parentId: string }[];
  operations: { position: number; kind: unknown; path: string; previousPath: string | null; objectId: string | null }[];
}) {
  const ancestry = await readDerived(change.repositoryId, change.id, "ancestry");
  if (typeof ancestry?.generation !== "number") throw new Error("Missing ancestry for line provenance");
  const generation = ancestry.generation;
  const files: File[] = [];
  const walk = new IndexedWalk(change.repositoryId);
  const parent = change.parents[0]?.parentId;
  let covered = 0; let skipped = 0; let remainingLines = MAX_TOTAL_LINES;
  for (const op of change.operations) {
    if (op.kind === "DELETE" || op.kind === "RENAME_SOURCE") continue;
    if (files.length >= MAX_INDEXED_FILES || remainingLines <= 0) { skipped++; continue; }
    const currentId = op.objectId || await currentObject(change.repositoryId, change.id, op.path);
    if (!currentId) { skipped++; continue; } // deleted or missing root
    const file: File = { repositoryId: change.repositoryId, changesetId: change.id,
      version: DERIVED_VERSION, position: op.position, path: op.path, generation, objectId: currentId,
      state: "UNAVAILABLE", lineCount: 0, spans: null, checksum: null };
    files.push(file);
    const current = await verifiedText(currentId);
    if (current === null) { skipped++; continue; }
    const newLines = linesOf(current);
    if (newLines.length > MAX_LINES || newLines.length > remainingLines) { skipped++; continue; }
    const origins = new Array<string>(newLines.length).fill(change.id);
    const priorPath = op.previousPath || op.path;
    if (parent) {
      const previousId = await currentObject(change.repositoryId, parent, priorPath);
      if (previousId) {
        const older = await latestBlameFile(change.repositoryId, parent, priorPath, walk);
        if (!older || older.objectId !== previousId || older.state !== "READY" ||
            older.checksum !== checksum(older.spans)) { skipped++; continue; }
        const oldOrigins = expandOrigins(older.spans, older.lineCount);
        if (older.objectId === currentId) {
          if (newLines.length !== oldOrigins.length) throw new Error("CORRUPT_BLAME_INDEX");
          for (let i = 0; i < origins.length; i++) origins[i] = oldOrigins[i];
        } else {
          const before = await verifiedText(previousId);
          if (before === null) { skipped++; continue; }
          const oldLines = linesOf(before);
          if (oldLines.length !== oldOrigins.length) throw new Error("CORRUPT_BLAME_INDEX");
          let pairs = matchingLines(oldLines, newLines);
          if (!pairs) {
            // Exact LCS in linear memory; avoid quadratic CPU amplification for
            // extremely unrelated files. A fully disjoint rewrite needs no DP.
            const prefix = (() => {
              let i = 0; while (i < oldLines.length && i < newLines.length &&
                oldLines[i] === newLines[i]) i++; return i;
            })();
            let suffix = 0;
            while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix &&
                oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]) suffix++;
            const oldMiddle = oldLines.slice(prefix, oldLines.length - suffix);
            const newMiddle = newLines.slice(prefix, newLines.length - suffix);
            const shared = new Set(oldMiddle);
            const disjoint = !newMiddle.some(line => shared.has(line));
            if (!disjoint && oldMiddle.length * newMiddle.length > 50_000_000) {
              skipped++; continue; // explicit UNAVAILABLE, never an incorrect origin
            }
            pairs = disjoint
              ? [...Array.from({ length: prefix }, (_, i) => [i, i] as [number, number]),
                 ...Array.from({ length: suffix }, (_, i) => [
                   oldLines.length - suffix + i, newLines.length - suffix + i,
                 ] as [number, number])]
              : matchingLinesLarge(oldLines, newLines);
          }
          for (const [oldIndex, newIndex] of pairs) origins[newIndex] = oldOrigins[oldIndex];
        }
      }
    }
    const spans = compressOrigins(origins);
    file.spans = spans; file.checksum = checksum(spans);
    file.state = "READY"; file.lineCount = newLines.length;
    remainingLines -= newLines.length;
    covered++;
  }
  return { files, payload: { lineStateVersion: 1, covered, skipped,
    totalOperations: change.operations.length, maxFileBytes: MAX_TEXT_BYTES } };
}
export async function indexedBlameLines(repositoryId: string, revision: string,
  path: string, currentId: string, content: string) {
  const indexed = await readDerived(repositoryId, revision, "blame");
  if (!indexed) { await enqueueDerived(repositoryId, revision, ["blame"]); return null; }
  const state = await latestBlameFile(repositoryId, revision, path);
  if (!state || state.state !== "READY" || state.objectId !== currentId) return null;
  if (checksum(state.spans) !== state.checksum) throw new Error("CORRUPT_BLAME_INDEX");
  const lines = linesOf(content);
  if (lines.length !== state.lineCount) throw new Error("CORRUPT_BLAME_INDEX");
  const origins = expandOrigins(state.spans, state.lineCount);
  return lines.map((text, index) => ({ line: index + 1, text, changesetId: origins[index] }));
}

/** Bounded, paginated line output with immutable origin provenance. */
export async function indexedBlamePage(repositoryId: string, revision: string, path: string,
  objectId: string, offset: number, limit: number) {
  const indexed = await readDerived(repositoryId, revision, "blame");
  if (!indexed) { await enqueueDerived(repositoryId, revision, ["blame"]); return null; }
  const state = await latestBlameFile(repositoryId, revision, path);
  if (!state || state.state !== "READY" || state.objectId !== objectId) return null;
  if (checksum(state.spans) !== state.checksum) throw new Error("CORRUPT_BLAME_INDEX");
  const content = await verifiedText(objectId);
  if (content === null) return null; // caller will distinguish binary/unavailable
  const lines = linesOf(content);
  if (lines.length !== state.lineCount) throw new Error("CORRUPT_BLAME_INDEX");
  const origins = expandOrigins(state.spans, state.lineCount);
  return { lines: lines.slice(offset, offset + limit).map((text, index) => ({
    line: offset + index + 1, text, changesetId: origins[offset + index],
  })), totalLines: lines.length, nextOffset: offset + limit < lines.length ? offset + limit : null };
}

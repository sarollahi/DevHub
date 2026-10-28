import type { TreeEntry } from "./contracts";

export type ChangeKind = "ADD" | "DELETE" | "MODIFY" | "RENAME" | "COPY";
export type TreeChange = {
  kind: ChangeKind; path: string; previousPath?: string; before?: string; after?: string;
};
export type Snapshot = ReadonlyMap<string, string>;

// Changesets store canonical immutable manifests. Comparing two manifests never
// replays historical changesets and does not write or advance a reference.
export function compareEntries(before: TreeEntry[], after: TreeEntry[]): TreeChange[] {
  const left = new Map(before.map(e => [e.path, e.objectId]));
  const right = new Map(after.map(e => [e.path, e.objectId]));
  const removed = new Map([...left].filter(([p]) => !right.has(p)));
  const added = new Map([...right].filter(([p]) => !left.has(p)));
  const changes: TreeChange[] = [];
  for (const [path, id] of left) {
    const next = right.get(path);
    if (next && next !== id) changes.push({ kind: "MODIFY", path, before: id, after: next });
  }
  // Exact object identities give deterministic, zero-false-positive detection.
  // Similarity-based detection would be an additional, explicitly heuristic pass.
  for (const [path, id] of [...added].sort(([a], [b]) => a.localeCompare(b))) {
    const prior = [...removed].find(([, value]) => value === id);
    if (prior) {
      changes.push({ kind: "RENAME", path, previousPath: prior[0], before: id, after: id });
      removed.delete(prior[0]); added.delete(path);
    }
  }
  for (const [path, id] of added) {
    const source = [...left].find(([oldPath, value]) => oldPath !== path && right.get(oldPath) === value && value === id);
    if (source) changes.push({ kind: "COPY", path, previousPath: source[0], before: id, after: id });
    else changes.push({ kind: "ADD", path, after: id });
  }
  for (const [path, id] of removed) changes.push({ kind: "DELETE", path, before: id });
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

export function mergeEntries(base: TreeEntry[], ours: TreeEntry[], theirs: TreeEntry[]) {
  const b = new Map(base.map(e => [e.path, e.objectId]));
  const a = new Map(ours.map(e => [e.path, e.objectId]));
  const c = new Map(theirs.map(e => [e.path, e.objectId]));
  const result = new Map<string, string>();
  const conflicts: { path: string; base: string | null; ours: string | null; theirs: string | null }[] = [];
  for (const path of new Set([...b.keys(), ...a.keys(), ...c.keys()])) {
    const original = b.get(path);
    const left = a.get(path);
    const right = c.get(path);
    let selected: string | undefined;
    if (left === right || right === original) selected = left;
    else if (left === original) selected = right;
    else {
      conflicts.push({ path, base: original ?? null, ours: left ?? null, theirs: right ?? null });
      selected = left; // Preserve ours in preview, never silently publish.
    }
    if (selected !== undefined) result.set(path, selected);
  }
  // Object-level comparison alone would incorrectly treat rename/rename and
  // rename/delete as two independent paths. Never preview those as clean.
  const movedA = new Map(compareEntries(base, ours).filter(x => x.kind === "RENAME")
    .map(x => [x.previousPath!, x.path]));
  const movedC = new Map(compareEntries(base, theirs).filter(x => x.kind === "RENAME")
    .map(x => [x.previousPath!, x.path]));
  for (const source of new Set([...movedA.keys(), ...movedC.keys()])) {
    const leftMove = movedA.get(source);
    const rightMove = movedC.get(source);
    const conflictingMoves = leftMove && rightMove && leftMove !== rightMove;
    const moveVsDelete = (leftMove && !rightMove && !c.has(source)) ||
      (rightMove && !leftMove && !a.has(source));
    if (conflictingMoves || moveVsDelete) {
      conflicts.push({ path: source, base: b.get(source) ?? null,
        ours: a.get(source) ?? null, theirs: c.get(source) ?? null });
    }
  }
  return { entries: [...result].map(([path, objectId]) => ({ path, objectId })).sort((x, y) => x.path.localeCompare(y.path)), conflicts };
}

export function linesOf(content: string): string[] {
  return content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

// Exact dynamic-programming line correspondence with a hard memory/time bound.
// The limit is deliberate: large blobs still return metadata, not a server OOM.
export function matchingLines(older: string[], newer: string[], maxCells = 1_500_000): [number, number][] | null {
  const n = older.length; const m = newer.length;
  if (n * m > maxCells) return null;
  const rows = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      rows[i][j] = older[i] === newer[j] ? 1 + rows[i + 1][j + 1] : Math.max(rows[i + 1][j], rows[i][j + 1]);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0; let j = 0;
  while (i < n && j < m) {
    if (older[i] === newer[j]) { pairs.push([i, j]); i++; j++; }
    else if (rows[i + 1][j] >= rows[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

export function textPatch(before: string, after: string) {
  const oldLines = linesOf(before); const newLines = linesOf(after);
  const pairs = matchingLines(oldLines, newLines);
  if (!pairs) return { patch: null, truncated: true, oldLines: oldLines.length, newLines: newLines.length };
  const body: string[] = [];
  let i = 0; let j = 0;
  for (const [left, right] of [...pairs, [oldLines.length, newLines.length] as [number, number]]) {
    while (i < left) body.push("-" + oldLines[i++].replace(/\n$/, ""));
    while (j < right) body.push("+" + newLines[j++].replace(/\n$/, ""));
    if (left < oldLines.length) {
      body.push(" " + oldLines[left].replace(/\n$/, ""));
      i++; j++;
    }
  }
  // Full-file hunk representation; clients can render/split hunks themselves.
  return { patch: `@@ -1,${oldLines.length} +1,${newLines.length} @@\n${body.join("\n")}`,
    truncated: false, oldLines: oldLines.length, newLines: newLines.length };
}

export function blameLines(content: string, events: { changesetId: string; content: string }[]) {
  const target = linesOf(content);
  if (!events.length) return target.map((text, index) => ({ line: index + 1, text, changesetId: null }));
  const result = target.map((text, index) => ({ line: index + 1, text, changesetId: events[0].changesetId }));
  // Positions of lines that remain unchanged all the way to an older revision.
  let live = new Map(target.map((_, index) => [index, index]));
  for (let e = 0; e + 1 < events.length && live.size; e++) {
    const oldLines = linesOf(events[e + 1].content);
    const newLines = linesOf(events[e].content);
    const pairs = matchingLines(oldLines, newLines);
    if (!pairs) break;
    const parentPosition = new Map(pairs.map(([oldIndex, newIndex]) => [newIndex, oldIndex]));
    const next = new Map<number, number>();
    for (const [originalIndex, currentIndex] of live) {
      const earlierIndex = parentPosition.get(currentIndex);
      if (earlierIndex !== undefined) {
        result[originalIndex].changesetId = events[e + 1].changesetId;
        next.set(originalIndex, earlierIndex);
      }
    }
    live = next;
  }
  return result;
}


/** Exact linear-space LCS for large text edits. Common prefix/suffix lines
 * are stripped before quadratic work, making million-line sparse edits cheap.
 * No heuristic match is ever assigned an older author. The caller must run
 * this in a background worker, not a synchronous HTTP read.
 */
export function matchingLinesLarge(older: string[], newer: string[]): [number, number][] {
  let prefix = 0;
  while (prefix < older.length && prefix < newer.length && older[prefix] === newer[prefix]) prefix++;
  let suffix = 0;
  while (suffix < older.length - prefix && suffix < newer.length - prefix &&
    older[older.length - 1 - suffix] === newer[newer.length - 1 - suffix]) suffix++;
  const result: [number, number][] = Array.from({ length: prefix }, (_, i) => [i, i]);
  const aEnd = older.length - suffix, bEnd = newer.length - suffix;
  function lengths(a0: number, a1: number, b0: number, b1: number, reverse: boolean) {
    const width = b1 - b0;
    let previous = new Uint32Array(width + 1);
    let current = new Uint32Array(width + 1);
    for (let i = 0; i < a1 - a0; i++) {
      const a = reverse ? older[a1 - 1 - i] : older[a0 + i];
      for (let j = 0; j < width; j++) {
        const b = reverse ? newer[b1 - 1 - j] : newer[b0 + j];
        current[j + 1] = a === b ? previous[j] + 1 :
          Math.max(current[j], previous[j + 1]);
      }
      [previous, current] = [current, previous];
      current.fill(0);
    }
    return previous;
  }
  function solve(a0: number, a1: number, b0: number, b1: number) {
    if (a0 >= a1 || b0 >= b1) return;
    if (a1 - a0 === 1) {
      for (let j = b0; j < b1; j++) {
        if (older[a0] === newer[j]) { result.push([a0, j]); break; }
      }
      return;
    }
    const mid = Math.floor((a0 + a1) / 2);
    const left = lengths(a0, mid, b0, b1, false);
    const right = lengths(mid, a1, b0, b1, true);
    let best = -1, split = 0;
    for (let j = 0; j <= b1 - b0; j++) {
      const value = left[j] + right[b1 - b0 - j];
      if (value > best) { best = value; split = j; }
    }
    solve(a0, mid, b0, b0 + split);
    solve(mid, a1, b0 + split, b1);
  }
  solve(prefix, aEnd, prefix, bEnd);
  for (let i = suffix; i > 0; i--) result.push([older.length - i, newer.length - i]);
  return result;
}

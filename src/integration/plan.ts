export type FileEntry = { path: string; objectId: string; mode?: string };
export type Conflict = { path: string; code: "EDIT_CONFLICT" | "PATH_COLLISION"; base: FileEntry | null; target: FileEntry | null; incoming: FileEntry | null };
export type MergeOperation = { kind: "ADD" | "MODIFY" | "DELETE" | "CHMOD"; path: string; objectId?: string; mode?: "100644" | "100755" | "120000" };
const mode = (entry: FileEntry | undefined) => entry?.mode ?? "100644";
const same = (a: FileEntry | undefined, b: FileEntry | undefined) =>
  (!a && !b) || (!!a && !!b && a.objectId === b.objectId && mode(a) === mode(b));
const normalize = (input: FileEntry[]) => new Map(input.map(e => [e.path, e]));
const sort = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** A conservative, deterministic, full-file three-way merge. No guessing at overlapping edits. */
export function planIntegration(base: FileEntry[], target: FileEntry[], incoming: FileEntry[]) {
  const b = normalize(base), t = normalize(target), i = normalize(incoming);
  const result = new Map(t);
  const conflicts: Conflict[] = [];
  const affectedPaths: string[] = [];
  for (const path of [...new Set([...b.keys(), ...i.keys()])].sort(sort)) {
    const original = b.get(path), desired = i.get(path), present = t.get(path);
    if (same(original, desired)) continue;
    affectedPaths.push(path);
    if (!same(original, present) && !same(desired, present)) {
      conflicts.push({ path, code: "EDIT_CONFLICT", base: original ?? null,
        target: present ?? null, incoming: desired ?? null });
      continue;
    }
    if (desired) result.set(path, desired); else result.delete(path);
  }
  // A file and its descendant cannot coexist, even if they came from disjoint changes.
  for (const path of [...result.keys()].sort(sort)) {
    const parts = path.split("/");
    for (let n = 1; n < parts.length; n++) {
      const parent = parts.slice(0, n).join("/");
      if (result.has(parent)) {
        conflicts.push({ path, code: "PATH_COLLISION", base: b.get(path) ?? null,
          target: t.get(path) ?? null, incoming: i.get(path) ?? null });
        break;
      }
    }
  }
  const operations: MergeOperation[] = [];
  if (!conflicts.length) for (const path of [...new Set([...t.keys(), ...result.keys()])].sort(sort)) {
    const old = t.get(path), next = result.get(path);
    if (same(old, next)) continue;
    if (!next) operations.push({ kind: "DELETE", path });
    else if (!old) operations.push({ kind: "ADD", path, objectId: next.objectId, mode: mode(next) as MergeOperation["mode"] });
    else if (old.objectId !== next.objectId) operations.push({ kind: "MODIFY", path,
      objectId: next.objectId, ...(mode(old) !== mode(next) ? { mode: mode(next) as MergeOperation["mode"] } : {}) });
    else operations.push({ kind: "CHMOD", path, mode: mode(next) as MergeOperation["mode"] });
  }
  return { affectedPaths, conflicts: conflicts.sort((a, b) => sort(a.path, b.path) || sort(a.code, b.code)), operations };
}

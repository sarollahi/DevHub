import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { SourceControlError } from "./contracts";
import { validPath } from "../lib/review-logic";

type Tx = Prisma.TransactionClient;
export type SnapshotEntry = { objectId: string; mode: "100644" | "100755" | "120000" };
type Edge = [string, string, number];
type Node = { value: SnapshotEntry | null; edges: Edge[]; count: number };
const hexId = /^[a-f0-9]{64}$/;
const edgePattern = /^[a-f0-9]+$/;
const maxEntries = 2_000_000;
const hash = (bytes: Uint8Array) => createHash("sha256").update("DEVHUB-SNAPSHOT-V1\0").update(bytes).digest("hex");
const key = (path: string) => Buffer.from(path, "utf8").toString("hex");
const shared = (a: string, b: string) => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
};
const invalid = () => new SourceControlError(409, "CORRUPT_SNAPSHOT", "Immutable snapshot node is missing or damaged");

function encode(node: Node) {
  return Buffer.from(JSON.stringify([1, node.value ? [node.value.objectId, node.value.mode] : null, node.edges]), "utf8");
}

function decode(data: Uint8Array): Node {
  let value: unknown;
  try { value = JSON.parse(Buffer.from(data).toString("utf8")); } catch { throw invalid(); }
  if (!Array.isArray(value) || value.length !== 3 || value[0] !== 1) throw invalid();
  const raw = value[1];
  if (raw !== null && (!Array.isArray(raw) || raw.length !== 2 || typeof raw[0] !== "string"
    || !hexId.test(raw[0]) || !["100644", "100755", "120000"].includes(raw[1]))) throw invalid();
  const edges: unknown = value[2];
  if (!Array.isArray(edges) || edges.length > 16) throw invalid();
  const first = new Set<string>();
  let count = raw === null ? 0 : 1;
  for (const edge of edges) {
    if (!Array.isArray(edge) || edge.length !== 3 || typeof edge[0] !== "string"
      || !edgePattern.test(edge[0]) || edge[0].length > 2048 || !hexId.test(edge[1])
      || !Number.isSafeInteger(edge[2]) || edge[2] < 1 || edge[2] > maxEntries
      || first.has(edge[0][0])) throw invalid();
    first.add(edge[0][0]);
    count += edge[2];
  }
  if (count > maxEntries) throw invalid();
  const node: Node = { value: raw === null ? null : { objectId: raw[0], mode: raw[1] },
    edges: edges as Edge[], count };
  if (!encode(node).equals(Buffer.from(data)) || edges.some((e, i) => i && edges[i - 1][0] >= e[0])) throw invalid();
  return node;
}

/**
 * An immutable, path-keyed compressed radix tree. Every node has at most 16
 * children; updates copy only the search path. No mutable repository head,
 * global publication lock, or full-file manifest is involved.
 *
 * Nodes are globally deduplicated by digest, but roots are repository-scoped.
 * Callers must authorize the repository before obtaining a root or a blob.
 */
export class SnapshotTree {
  private readonly cache = new Map<string, Node>();
  private readonly pending = new Map<string, Uint8Array>();
  constructor(private readonly tx: Tx) {}

  private make(value: SnapshotEntry | null, edges: Edge[]): string {
    const sorted = [...edges].sort((a, b) => a[0].localeCompare(b[0], "en"));
    const node = { value, edges: sorted, count: (value ? 1 : 0) + sorted.reduce((n, edge) => n + edge[2], 0) };
    if (node.count > maxEntries) throw new SourceControlError(413, "TOO_MANY_PATHS", "Snapshot file-count limit exceeded");
    const bytes = encode(node);
    const id = hash(bytes);
    this.cache.set(id, node);
    this.pending.set(id, bytes);
    return id;
  }

  empty(): string { return this.make(null, []); }

  private async read(id: string, expectedCount?: number): Promise<Node> {
    let node = this.cache.get(id);
    if (!node) {
      const record = await this.tx.sourceSnapshotNode.findUnique({ where: { id }, select: { data: true } });
      if (!record || hash(record.data) !== id) throw invalid();
      node = decode(record.data);
      this.cache.set(id, node);
    }
    if (expectedCount !== undefined && node.count !== expectedCount) throw invalid();
    return node;
  }

  async count(root: string): Promise<number> { return (await this.read(root)).count; }

  async get(root: string, path: string): Promise<SnapshotEntry | undefined> {
    let remainder = key(path);
    let cursor = root;
    for (;;) {
      const node = await this.read(cursor);
      if (!remainder.length) return node.value ?? undefined;
      const edge = node.edges.find(e => remainder.startsWith(e[0]));
      if (!edge) return undefined;
      remainder = remainder.slice(edge[0].length);
      cursor = edge[1];
      await this.read(cursor, edge[2]);
    }
  }

  // Only checks a path prefix in the radix index; never enumerates its descendants.
  async hasPrefix(root: string, prefix: string): Promise<boolean> {
    let remainder = key(prefix);
    let cursor = root;
    for (;;) {
      const node = await this.read(cursor);
      if (!remainder.length) return node.count > 0;
      const edge = node.edges.find(e => e[0][0] === remainder[0]);
      if (!edge) return false;
      const length = shared(edge[0], remainder);
      if (length === remainder.length) return true;
      if (length !== edge[0].length) return false;
      remainder = remainder.slice(length);
      cursor = edge[1];
      await this.read(cursor, edge[2]);
    }
  }

  private async change(nodeId: string, remaining: string, value: SnapshotEntry | null): Promise<string> {
    const node = await this.read(nodeId);
    if (!remaining.length) return this.make(value, node.edges);
    const edges = node.edges.map(e => [...e] as Edge);
    const index = edges.findIndex(e => e[0][0] === remaining[0]);
    if (index === -1) {
      if (value) {
        const leaf = this.make(value, []);
        edges.push([remaining, leaf, 1]);
      }
      return this.make(node.value, edges);
    }
    const [label, childId, expected] = edges[index];
    const length = shared(label, remaining);
    if (length === label.length) {
      await this.read(childId, expected);
      const nextId = await this.change(childId, remaining.slice(length), value);
      const next = await this.read(nextId);
      if (!next.count) edges.splice(index, 1);
      else if (!next.value && next.edges.length === 1) {
        const only = next.edges[0];
        edges[index] = [label + only[0], only[1], only[2]];
      } else edges[index] = [label, nextId, next.count];
    } else if (value) {
      const oldSuffix = label.slice(length);
      const newSuffix = remaining.slice(length);
      const forkEdges: Edge[] = [[oldSuffix, childId, expected]];
      if (newSuffix) {
        const leaf = this.make(value, []);
        forkEdges.push([newSuffix, leaf, 1]);
      }
      const fork = this.make(newSuffix ? null : value, forkEdges);
      edges[index] = [label.slice(0, length), fork, (await this.read(fork)).count];
    }
    return this.make(node.value, edges);
  }

  async set(root: string, path: string, value: SnapshotEntry | null): Promise<string> {
    return this.change(root, key(path), value);
  }

  async checkSlot(root: string, path: string) {
    if (!validPath(path)) throw new SourceControlError(422, "INVALID_PATH_GRAPH", "Invalid repository path");
    const segments = path.split("/");
    for (let i = 1; i < segments.length; i++) {
      if (await this.get(root, segments.slice(0, i).join("/"))) {
        throw new SourceControlError(422, "INVALID_PATH_GRAPH", "File cannot contain other paths");
      }
    }
    if (await this.hasPrefix(root, path + "/")) {
      throw new SourceControlError(422, "INVALID_PATH_GRAPH", "File cannot replace an occupied directory");
    }
  }

  async materialize(entries: Iterable<[string, SnapshotEntry]>): Promise<string> {
    let root = this.empty();
    for (const [path, entry] of entries) {
      await this.checkSlot(root, path);
      root = await this.set(root, path, entry);
    }
    return root;
  }

  async persist(root: string): Promise<number> {
    // Retain only pending nodes reachable from the final root; intermediate
    // copy-on-write versions never enter the database.
    const visited = new Set<string>();
    const rows: Array<{ id: string; data: Uint8Array }> = [];
    const visit = (id: string) => {
      if (visited.has(id)) return;
      visited.add(id);
      const bytes = this.pending.get(id);
      if (!bytes) return; // Already stored and hash-checked by read().
      rows.push({ id, data: bytes });
      const node = this.cache.get(id)!;
      for (const [, child] of node.edges) visit(child);
    };
    visit(root);
    for (let i = 0; i < rows.length; i += 500) {
      await this.tx.sourceSnapshotNode.createMany({ data: rows.slice(i, i + 500), skipDuplicates: true });
    }
    return rows.reduce((sum, row) => sum + row.data.byteLength, 0);
  }

  async entries(root: string): Promise<Array<{ path: string } & SnapshotEntry>> {
    const result: Array<{ path: string } & SnapshotEntry> = [];
    const visit = async (id: string, prefix: string, expected?: number): Promise<void> => {
      const node = await this.read(id, expected);
      if (node.value) {
        let path: string;
        try { path = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(prefix, "hex")); }
        catch { throw invalid(); }
        if (!validPath(path)) throw invalid();
        result.push({ path, ...node.value });
      }
      for (const [label, child, count] of node.edges) await visit(child, prefix + label, count);
    };
    await visit(root, "");
    // Preserve historical snapshot API ordering.
    return result.sort((a, b) => a.path.localeCompare(b.path));
  }
}

export async function publishedSnapshotRoot(tx: Tx, repositoryId: string, changesetId: string) {
  return tx.sourceSnapshotRoot.findFirst({ where: { repositoryId, changesetId }, select: { rootId: true } });
}

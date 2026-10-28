import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "../lib/prisma";
import { SnapshotTree } from "./snapshot-tree";

export const DERIVED_VERSION = 2;
export const DERIVED_KINDS = ["ancestry", "changed-paths", "directory", "history", "impact", "blame"] as const;
export type DerivedKind = typeof DERIVED_KINDS[number];
type Payload = Record<string, unknown>;
type Change = Awaited<ReturnType<typeof loadRevision>>;
type Computation = {
  payload: Payload;
  jumps?: { repositoryId: string; changesetId: string; version: number; level: number; ancestorId: string }[];
  postings?: { repositoryId: string; changesetId: string; version: number; position: number; role: string; path: string;
    generation: number; kind: string; previousPath: string | null; objectId: string | null }[];
  blameFiles?: { repositoryId: string; changesetId: string; version: number; position: number; path: string;
    generation: number; objectId: string; state: string; lineCount: number; spans: unknown; checksum: string | null }[];
};
type Context = { change: Change; parents: Map<string, Payload[]>; current: Map<string, Payload> };
type Definition = {
  parentDependency: boolean;
  prerequisites: DerivedKind[];
  compute: (ctx: Context) => Promise<Computation>;
};

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  if (value !== null && typeof value === "object") return "{" +
    Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => JSON.stringify(k) + ":" + stableJson(v)).join(",") + "}";
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("INVALID_DERIVED_JSON");
  return encoded;
}
export const checksum = (value: unknown) => createHash("sha256").update(stableJson(value)).digest("hex");
const key = (changesetId: string, kind: DerivedKind) => ({ changesetId, kind, version: DERIVED_VERSION });

async function loadRevision(repositoryId: string, changesetId: string) {
  const change = await db.sourceChangeset.findFirst({ where: { id: changesetId, repositoryId },
    select: { id: true, repositoryId: true,
      parents: { orderBy: { position: "asc" }, select: { parentId: true } },
      operations: { orderBy: { position: "asc" }, select: {
        position: true, kind: true, path: true, previousPath: true, objectId: true,
      } },
    },
  });
  if (!change) throw new Error("Index revision does not belong to repository");
  // Legacy v1 persisted every operation with default position=0. Never key
  // derived postings by that non-unique legacy value. Canonical v2 retains its
  // explicit order; ties are deterministically ordered by unique path.
  const ordered = [...change.operations].sort((a, b) =>
    a.position - b.position || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { ...change, operations: ordered.map((op, position) => ({ ...op, position })) };
}
export async function readDerived(repositoryId: string, changesetId: string, kind: DerivedKind): Promise<Payload | null> {
  const row = await db.sourceDerivedIndex.findUnique({ where: { changesetId_kind_version: key(changesetId, kind) } });
  if (!row || row.repositoryId !== repositoryId || row.state !== "SUCCEEDED") return null;
  if (row.payload === null || row.checksum !== checksum(row.payload)) throw new Error("CORRUPT_DERIVED_INDEX");
  return row.payload as Payload;
}
async function verifiedParents(repositoryId: string, change: Change, kind: DerivedKind): Promise<Payload[] | null> {
  const values: Payload[] = [];
  for (const parent of change.parents) {
    const result = await readDerived(repositoryId, parent.parentId, kind);
    if (!result) return null;
    values.push(result);
  }
  return values;
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("CORRUPT_DERIVED_INDEX");
  return value;
}
const definitions: Record<DerivedKind, Definition> = {
  ancestry: { parentDependency: true, prerequisites: [], async compute({ change, parents }) {
    const prior = parents.get("ancestry") || [];
    const generation = Math.max(-1, ...prior.map(p => integer(p.generation))) + 1;
    const depth = change.parents.length ? integer(prior[0].firstParentDepth) + 1 : 0;
    const linear = change.parents.length === 0 || (change.parents.length === 1 && prior[0].linear === true);
    // A nearest-merge pointer compresses arbitrarily long linear stretches in a
    // merge DAG. Each query examines merge vertices, not every intervening commit.
    const nearestMerge = change.parents.length > 1 ? change.id :
      change.parents.length ? (prior[0].nearestMerge ?? null) : null;
    const jumps: NonNullable<Computation["jumps"]> = [];
    if (change.parents.length) {
      let ancestorId = change.parents[0].parentId;
      for (let level = 0; level < 54 && ancestorId; level++) {
        jumps.push({ repositoryId: change.repositoryId, changesetId: change.id, version: DERIVED_VERSION, level, ancestorId });
        const next = await db.sourceDerivedJump.findUnique({
          where: { changesetId_version_level: { changesetId: ancestorId, version: DERIVED_VERSION, level } },
          select: { ancestorId: true, repositoryId: true },
        });
        if (next && next.repositoryId !== change.repositoryId) throw new Error("CROSS_REPOSITORY_JUMP");
        ancestorId = next?.ancestorId ?? "";
      }
    }
    return { payload: { generation, firstParentDepth: depth, nearestMerge, linear, parentCount: change.parents.length }, jumps };
  } },
  "changed-paths": { parentDependency: false, prerequisites: [], async compute({ change }) {
    const paths = new Set<string>();
    for (const op of change.operations) { paths.add(op.path); if (op.previousPath) paths.add(op.previousPath); }
    return { payload: { count: paths.size, operationCount: change.operations.length,
      pathDigest: checksum([...paths].sort()) } };
  } },
  directory: { parentDependency: false, prerequisites: [], async compute({ change }) {
    const root = await db.sourceSnapshotRoot.findFirst({ where: {
      changesetId: change.id, repositoryId: change.repositoryId,
    }, select: { rootId: true } });
    if (root) await new SnapshotTree(db).count(root.rootId); // verify the immutable root
    // Unmaterialized legacy revisions are never represented as a complete tree.
    return { payload: { rootId: root?.rootId ?? null, available: !!root } };
  } },
  history: { parentDependency: true, prerequisites: ["ancestry"], async compute({ change, current }) {
    const generation = integer(current.get("ancestry")?.generation);
    const postings: NonNullable<Computation["postings"]> = [];
    for (const op of change.operations) {
      postings.push({ repositoryId: change.repositoryId, changesetId: change.id, version: DERIVED_VERSION, position: op.position,
        role: "destination", path: op.path, kind: String(op.kind), generation,
        previousPath: op.previousPath, objectId: op.objectId });
      if (op.previousPath) postings.push({ repositoryId: change.repositoryId, changesetId: change.id,
        version: DERIVED_VERSION, position: op.position, role: "source", path: op.previousPath, kind: String(op.kind),
        generation, previousPath: op.previousPath, objectId: op.objectId });
    }
    return { payload: { generation, postings: postings.length }, postings };
  } },
  impact: { parentDependency: true, prerequisites: ["changed-paths"], async compute({ change, parents, current }) {
    const opCount = change.operations.length;
    const previous = parents.get("impact") || [];
    // First-parent cumulative metric only: never double-count a merge's shared ancestors.
    const firstParentOperations = integer(previous[0]?.firstParentOperations ?? 0) + opCount;
    return { payload: { opCount, changedPaths: current.get("changed-paths")?.count ?? 0,
      firstParentOperations, mergeParents: Math.max(0, change.parents.length - 1) } };
  } },
  blame: { parentDependency: true, prerequisites: ["history"], async compute({ change }) {
    // Sparse changed-file origins only; no full-repository line snapshot.
    const { computeBlameFiles } = await import("./indexed-blame");
    const computed = await computeBlameFiles(change);
    return { payload: computed.payload, blameFiles: computed.files };
  } },
};

export async function enqueueDerived(repositoryId: string, changesetId: string, kinds: readonly DerivedKind[] = DERIVED_KINDS) {
  if (!kinds.length) return;
  const change = await db.sourceChangeset.findFirst({ where: { repositoryId, id: changesetId }, select: { id: true } });
  if (!change) throw new Error("Unknown index revision");
  await db.sourceDerivedIndex.createMany({ data: kinds.map(kind => ({
    repositoryId, changesetId, kind, version: DERIVED_VERSION,
  })), skipDuplicates: true });
}
export async function requeueFailedDerived(repositoryId: string, changesetId: string, kind: DerivedKind) {
  return db.sourceDerivedIndex.updateMany({ where: { ...key(changesetId, kind),
    repositoryId, state: "FAILED" }, data: {
    state: "QUEUED", nextAttemptAt: new Date(), lastError: null, attempts: 0,
  } });
}

// A published result has exactly one writer: token-fenced CAS in the same
// transaction as all secondary postings. Lost leases discard their work.
export async function processDerivedIndex(changesetId: string, kind: DerivedKind, version = DERIVED_VERSION) {
  if (version !== DERIVED_VERSION) return false;
  const now = new Date();
  const token = randomUUID();
  const leaseUntil = new Date(now.getTime() + 120_000);
  const claim = await db.sourceDerivedIndex.updateMany({
    where: { ...key(changesetId, kind), nextAttemptAt: { lte: now },
      OR: [{ state: "QUEUED" }, { state: "RUNNING", leaseUntil: { lt: now } }] },
    data: { state: "RUNNING", leaseToken: token, leaseUntil, attempts: { increment: 1 }, lastError: null },
  });
  if (!claim.count) return false;
  try {
    const row = await db.sourceDerivedIndex.findUniqueOrThrow({ where: { changesetId_kind_version: key(changesetId, kind) } });
    const change = await loadRevision(row.repositoryId, changesetId);
    const definition = definitions[kind];
    const parents = new Map<string, Payload[]>();
    const current = new Map<string, Payload>();
    for (const dependency of new Set<DerivedKind>([...definition.prerequisites, ...(definition.parentDependency ? [kind] : [])])) {
      if (definition.parentDependency && dependency === kind) {
        const values = await verifiedParents(row.repositoryId, change, kind);
        if (!values) {
          await db.sourceDerivedIndex.createMany({ data: change.parents.map(p => ({
            repositoryId: row.repositoryId, changesetId: p.parentId, kind, version: DERIVED_VERSION,
          })), skipDuplicates: true });
          await defer(changesetId, kind, token);
          return false;
        }
        parents.set(kind, values);
      }
      if (definition.prerequisites.includes(dependency)) {
        const value = await readDerived(row.repositoryId, changesetId, dependency);
        if (!value) {
          await enqueueDerived(row.repositoryId, changesetId, [dependency]);
          await defer(changesetId, kind, token);
          return false;
        }
        current.set(dependency, value);
      }
    }
    const output = await definition.compute({ change, parents, current });
    const sum = checksum(output.payload);
    await db.$transaction(async tx => {
      const fenced = await tx.sourceDerivedIndex.updateMany({ where: {
        ...key(changesetId, kind), state: "RUNNING", leaseToken: token, leaseUntil: { gt: new Date() },
      }, data: { payload: output.payload as Prisma.InputJsonValue, checksum: sum,
        state: "SUCCEEDED", finishedAt: new Date(), leaseUntil: null, leaseToken: null } });
      if (fenced.count !== 1) throw new Error("INDEX_LEASE_LOST");
      if (output.jumps?.length) await tx.sourceDerivedJump.createMany({ data: output.jumps });
      if (output.postings?.length) {
        for (let i = 0; i < output.postings.length; i += 250) {
          await tx.sourceDerivedPathEvent.createMany({ data: output.postings.slice(i, i + 250) });
        }
      }
      if (output.blameFiles?.length) {
        for (let i = 0; i < output.blameFiles.length; i += 100) {
          await tx.sourceDerivedBlameFile.createMany({ data: output.blameFiles.slice(i, i + 100).map(file => ({
            ...file, spans: file.spans === null ? Prisma.DbNull : file.spans as Prisma.InputJsonValue,
          })) });
        }
      }
    }, { timeout: 60000 });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 1000) : "Unknown failure";
    const current = await db.sourceDerivedIndex.findUnique({ where: { changesetId_kind_version: key(changesetId, kind) } });
    if (current?.leaseToken === token && current.state === "RUNNING") {
      await db.sourceDerivedIndex.updateMany({ where: { ...key(changesetId, kind), leaseToken: token, state: "RUNNING" },
        data: { state: current.attempts >= 10 ? "FAILED" : "QUEUED",
          leaseToken: null, leaseUntil: null, lastError: message,
          nextAttemptAt: new Date(Date.now() + Math.min(60_000, 500 * 2 ** Math.min(current.attempts, 7))) } });
    }
    throw error;
  }
}
async function defer(changesetId: string, kind: DerivedKind, token: string) {
  await db.sourceDerivedIndex.updateMany({ where: { ...key(changesetId, kind), state: "RUNNING", leaseToken: token },
    data: { state: "QUEUED", leaseToken: null, leaseUntil: null,
      nextAttemptAt: new Date(Date.now() + 500) } });
}
export async function processDerivedBatch(max = 32) {
  const rows = await db.sourceDerivedIndex.findMany({
    where: { version: DERIVED_VERSION, nextAttemptAt: { lte: new Date() },
      OR: [{ state: "QUEUED" }, { state: "RUNNING", leaseUntil: { lt: new Date() } }] },
    select: { changesetId: true, kind: true }, orderBy: { createdAt: "asc" },
    take: Math.max(1, Math.min(64, max)),
  });
  let completed = 0;
  for (const row of rows) {
    if (!DERIVED_KINDS.includes(row.kind as DerivedKind)) continue;
    try { if (await processDerivedIndex(row.changesetId, row.kind as DerivedKind)) completed++; }
    catch (error) { console.error("Derived index computation failed", row.changesetId, row.kind, error); }
  }
  return { inspected: rows.length, completed };
}

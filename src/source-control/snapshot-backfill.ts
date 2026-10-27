import { Prisma } from "@prisma/client";
import { db } from "../lib/prisma";
import { assertRepositoryPermission } from "../lib/authorization";
import { validPath } from "../lib/review-logic";
import { SourceControlError, type SourceActor } from "./contracts";
import { decodeTree } from "./storage";
import { SnapshotTree, publishedSnapshotRoot, type SnapshotEntry } from "./snapshot-tree";

type Tx = Prisma.TransactionClient;
const invalid = (message: string) => new SourceControlError(409, "CORRUPT_HISTORY", message);

/** Legacy v1 full-tree anchors are bounded by the old v1 writer. Never replay
 * first-parent operations inside a read or publication transaction. */
export async function legacyRoot(tx: Tx, repositoryId: string, changesetId: string, treeId: string, tree: SnapshotTree) {
  const existing = await publishedSnapshotRoot(tx, repositoryId, changesetId);
  if (existing) { await tree.count(existing.rootId); return existing.rootId; }
  const object = await tx.sourceObject.findUnique({ where: { id: treeId },
    select: { data: true, kind: true } });
  if (!object || object.kind !== "TREE" || !object.data) throw invalid("Legacy tree is missing");
  const entries = decodeTree(object.data, treeId);
  const computed = await tree.materialize(entries.map(entry =>
    [entry.path, { objectId: entry.objectId, mode: entry.mode || "100644" }] as [string, SnapshotEntry]));
  await tree.persist(computed);
  await tx.sourceSnapshotRoot.createMany({ data: [{ repositoryId, changesetId, rootId: computed }],
    skipDuplicates: true });
  const actual = await publishedSnapshotRoot(tx, repositoryId, changesetId);
  if (!actual || actual.rootId !== computed) throw invalid("Conflicting immutable legacy root");
  return computed;
}

type HistoricOperation = {
  kind: string; path: string; previousPath: string | null; objectId: string | null;
  fileMode: string | null;
};

export async function applyHistoricalOperations(tree: SnapshotTree, parentRoot: string, operations: HistoricOperation[]) {
  let root = parentRoot;
  const touched = new Set<string>();
  for (const op of operations) {
    if (!validPath(op.path) || (op.previousPath && !validPath(op.previousPath))) throw invalid("Invalid historical path");
    const previous = await tree.get(root, op.path);
    const source = op.previousPath ? await tree.get(root, op.previousPath) : undefined;
    touched.add(op.path);
    if (op.previousPath) touched.add(op.previousPath);
    if (op.kind === "ADD" || op.kind === "MODIFY" || op.kind === "PUT") {
      if (!op.objectId) throw invalid("Missing historical blob");
      if (op.kind === "ADD" && previous) throw invalid("Historical add destination exists");
      if (op.kind === "MODIFY" && !previous) throw invalid("Historical modify source is missing");
      root = await tree.set(root, op.path, { objectId: op.objectId,
        mode: (op.fileMode || previous?.mode || "100644") as SnapshotEntry["mode"] });
    } else if (op.kind === "DELETE") {
      if (!previous) throw invalid("Historical delete source is missing");
      root = await tree.set(root, op.path, null);
    } else if (op.kind === "MOVE" || op.kind === "RENAME" || op.kind === "COPY") {
      if (!source || previous || op.previousPath === op.path) throw invalid("Invalid historical move/copy");
      if (op.kind !== "COPY") root = await tree.set(root, op.previousPath!, null);
      root = await tree.set(root, op.path, source);
    } else if (op.kind === "CHMOD") {
      if (!previous || previous.mode === "120000" || !["100644", "100755"].includes(op.fileMode || "")) {
        throw invalid("Invalid historical permission change");
      }
      root = await tree.set(root, op.path, { ...previous, mode: op.fileMode as SnapshotEntry["mode"] });
    } else throw invalid("Unknown historical operation");
  }
  for (const path of touched) {
    if (await tree.get(root, path)) await tree.checkSlot(root, path);
  }
  return root;
}

/**
 * Backfill one bounded discovery or application chunk. Work is resumable:
 * discovered ancestor IDs are persisted once; every applied revision publishes
 * its immutable root and advances progress in the SAME transaction.
 *
 * The mutable build state is advisory. It never authorizes writes or overrides
 * SourceChangeset's parents/operations; readers only trust checked immutable roots.
 */
export async function advanceSnapshotBuild(
  repositoryId: string, targetId: string, actor: SourceActor,
  discoveryBudget = 128, applyBudget = 16,
) {
  if (!Number.isSafeInteger(discoveryBudget) || discoveryBudget < 1 || discoveryBudget > 512 ||
      !Number.isSafeInteger(applyBudget) || applyBudget < 1 || applyBudget > 64) {
    throw new SourceControlError(422, "INVALID_BUDGET", "Invalid migration work budget");
  }
  await assertRepositoryPermission(actor, repositoryId, "changeset:write");
  const revision = await db.sourceChangeset.findFirst({
    where: { id: targetId, repositoryId }, select: { id: true },
  });
  if (!revision) throw new SourceControlError(404, "NOT_FOUND", "Changeset not found");

  const existing = await db.sourceSnapshotRoot.findFirst({
    where: { changesetId: targetId, repositoryId }, select: { rootId: true },
  });
  if (existing) {
    const tree = new SnapshotTree(db);
    return { materialized: true, targetId, rootId: existing.rootId,
      pathCount: await tree.count(existing.rootId), phase: "DONE", discovered: 0, applied: 0 };
  }
  await db.sourceSnapshotBuild.createMany({
    data: [{ targetId, repositoryId, cursorId: targetId }], skipDuplicates: true,
  });

  const progress = await db.sourceSnapshotBuild.findUniqueOrThrow({ where: { targetId } });
  if (progress.repositoryId !== repositoryId) throw invalid("Migration repository mismatch");
  if (progress.phase === "DISCOVER") {
    await db.$transaction(async tx => {
      const build = await tx.sourceSnapshotBuild.findUniqueOrThrow({ where: { targetId } });
      if (build.phase !== "DISCOVER") return;
      let cursor = build.cursorId;
      let anchor: string | null = null;
      let phase = "DISCOVER";
      const steps: Array<{ targetId: string; position: number; changesetId: string }> = [];
      while (cursor && steps.length < discoveryBudget) {
        const rooted = await publishedSnapshotRoot(tx, repositoryId, cursor);
        if (rooted) { anchor = cursor; phase = "APPLY"; break; }
        const change = await tx.sourceChangeset.findFirst({ where: { id: cursor, repositoryId },
          select: { id: true, treeId: true, parents: { where: { position: 0 }, select: { parentId: true } } } });
        if (!change) throw invalid("First-parent points outside the repository");
        if (change.treeId) { anchor = cursor; phase = "APPLY"; break; }
        steps.push({ targetId, position: build.discovered + steps.length, changesetId: cursor });
        cursor = change.parents[0]?.parentId || null;
      }
      if (!cursor) phase = "APPLY";
      if (steps.length) await tx.sourceSnapshotBuildStep.createMany({ data: steps });
      const updated = await tx.sourceSnapshotBuild.updateMany({
        where: { targetId, phase: "DISCOVER", cursorId: build.cursorId, discovered: build.discovered },
        data: { cursorId: cursor, anchorId: anchor, phase, discovered: build.discovered + steps.length },
      });
      if (updated.count !== 1) throw new SourceControlError(409, "BUILD_BUSY", "Concurrent migration advanced the cursor");
    }, { timeout: 60000 });
  } else if (progress.phase === "APPLY") {
    for (let i = 0; i < applyBudget; i++) {
      const finished = await db.$transaction(async tx => {
        const build = await tx.sourceSnapshotBuild.findUniqueOrThrow({ where: { targetId } });
        if (build.phase !== "APPLY") return true;
        const tree = new SnapshotTree(tx);
        if (build.applied === build.discovered) {
          if (build.anchorId) {
            const anchor = await tx.sourceChangeset.findFirst({ where: { id: build.anchorId, repositoryId },
              select: { treeId: true } });
            if (!anchor) throw invalid("Missing migration anchor");
            if (anchor.treeId) await legacyRoot(tx, repositoryId, build.anchorId, anchor.treeId, tree);
          }
          if (!(await publishedSnapshotRoot(tx, repositoryId, targetId))) {
            throw invalid("Build completed without a reachable target root");
          }
          const updated = await tx.sourceSnapshotBuild.updateMany({
            where: { targetId, phase: "APPLY", applied: build.applied }, data: { phase: "DONE" },
          });
          if (updated.count !== 1) throw new SourceControlError(409, "BUILD_BUSY", "Build was advanced concurrently");
          return true;
        }
        const step = await tx.sourceSnapshotBuildStep.findUniqueOrThrow({ where: {
          targetId_position: { targetId, position: build.discovered - build.applied - 1 },
        } });
        const change = await tx.sourceChangeset.findFirst({ where: { id: step.changesetId, repositoryId },
          select: { id: true, treeId: true, parents: { where: { position: 0 }, select: { parentId: true } },
            operations: { orderBy: { position: "asc" }, select: {
              kind: true, path: true, previousPath: true, objectId: true, fileMode: true,
            } } } });
        if (!change || change.treeId) throw invalid("Unexpected migration step");
        const parentId = change.parents[0]?.parentId;
        let root = tree.empty();
        if (parentId) {
          let parent = await publishedSnapshotRoot(tx, repositoryId, parentId);
          if (!parent && parentId === build.anchorId) {
            const anchor = await tx.sourceChangeset.findFirst({ where: { repositoryId, id: parentId },
              select: { treeId: true } });
            if (anchor?.treeId) {
              await legacyRoot(tx, repositoryId, parentId, anchor.treeId, tree);
              parent = await publishedSnapshotRoot(tx, repositoryId, parentId);
            }
          }
          if (!parent) throw invalid("Missing checkpoint parent root");
          root = parent.rootId;
          await tree.count(root);
        }
        const computed = await applyHistoricalOperations(tree, root, change.operations);
        await tree.persist(computed);
        await tx.sourceSnapshotRoot.createMany({
          data: [{ repositoryId, changesetId: change.id, rootId: computed }], skipDuplicates: true,
        });
        const actual = await publishedSnapshotRoot(tx, repositoryId, change.id);
        if (!actual || actual.rootId !== computed) throw invalid("Conflicting immutable checkpoint");
        const updated = await tx.sourceSnapshotBuild.updateMany({
          where: { targetId, phase: "APPLY", applied: build.applied },
          data: { applied: build.applied + 1 },
        });
        if (updated.count !== 1) throw new SourceControlError(409, "BUILD_BUSY", "Build was advanced concurrently");
        return false;
      }, { timeout: 60000 });
      if (finished) break;
    }
  }

  const latest = await db.sourceSnapshotBuild.findUniqueOrThrow({ where: { targetId } });
  const root = await db.sourceSnapshotRoot.findFirst({
    where: { repositoryId, changesetId: targetId }, select: { rootId: true },
  });
  if (root) {
    const tree = new SnapshotTree(db);
    return { materialized: true, targetId, rootId: root.rootId,
      pathCount: await tree.count(root.rootId), phase: latest.phase,
      discovered: latest.discovered, applied: latest.applied };
  }
  return { materialized: false, targetId, phase: latest.phase,
    discovered: latest.discovered, applied: latest.applied, cursorId: latest.cursorId };
}

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/prisma";
import { requireRepositoryAccess, sourceFailure } from "@/source-control/http";
import { advanceSnapshotBuild } from "@/source-control/snapshot-backfill";
import { publishedSnapshotRoot, SnapshotTree } from "@/source-control/snapshot-tree";
import { SourceControlError } from "@/source-control/contracts";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string; changesetId: string }> };

// Reports materialization only. Never performs an expensive historical replay
// or exposes global content-addressed nodes to an unauthorized caller.
export async function GET(request: NextRequest, { params }: Context) {
  try {
    const { id, changesetId } = await params;
    await requireRepositoryAccess(request, id, "changesets:read");
    return NextResponse.json(await db.$transaction(async tx => {
      const change = await tx.sourceChangeset.findFirst({ where: { id: changesetId, repositoryId: id }, select: { id: true } });
      if (!change) throw new SourceControlError(404, "NOT_FOUND", "Changeset not found");
      const root = await publishedSnapshotRoot(tx, id, changesetId);
      if (!root) {
        const build = await tx.sourceSnapshotBuild.findFirst({ where: { repositoryId: id, targetId: changesetId },
          select: { phase: true, discovered: true, applied: true } });
        return { changesetId, materialized: false, migration: build };
      }
      const tree = new SnapshotTree(tx);
      return { changesetId, materialized: true, rootId: root.rootId, fileCount: await tree.count(root.rootId) };
    }));
  } catch (error) { return sourceFailure(error); }
}

// Explicit opt-in for lazy migration. The caller must have publication rights;
// a read-only request must never trigger a large backfill transaction.
export async function POST(request: NextRequest, { params }: Context) {
  try {
    const { id, changesetId } = await params;
    const { actor } = await requireRepositoryAccess(request, id, "changesets:write");
    const discovery = Number(request.nextUrl.searchParams.get("discover") ?? 128);
    const apply = Number(request.nextUrl.searchParams.get("apply") ?? 16);
    return NextResponse.json({ changesetId,
      ...await advanceSnapshotBuild(id, changesetId, actor, discovery, apply) });
  } catch (error) { return sourceFailure(error); }
}

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/prisma";
import { requireRepositoryAccess, sourceFailure } from "@/source-control/http";
import { materializeCanonicalSnapshot } from "@/source-control/canonical";
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
      if (!root) return { changesetId, materialized: false };
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
    return NextResponse.json({ materialized: true,
      ...await materializeCanonicalSnapshot(id, changesetId, actor) });
  } catch (error) { return sourceFailure(error); }
}

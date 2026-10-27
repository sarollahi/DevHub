import { NextRequest, NextResponse } from "next/server";
import { requireRepositoryAccess, sourceFailure } from "@/source-control/http";
import { approveChangeset } from "@/source-control/service";
export const runtime = "nodejs";
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; changesetId: string }> }) {
  try {
    const { id, changesetId } = await params;
    const { actor } = await requireRepositoryAccess(req, id, "changesets:approve", true);
    return NextResponse.json(await approveChangeset(id, changesetId, actor));
  } catch (error) { return sourceFailure(error); }
}

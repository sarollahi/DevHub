import { NextRequest, NextResponse } from "next/server";
import { requireRepositoryAccess, sourceFailure } from "@/source-control/http";
import { getChangeset } from "@/source-control/service";
export const runtime = "nodejs";
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; changesetId: string }> }) {
  try {
    const { id, changesetId } = await params;
    const { actor } = await requireRepositoryAccess(req, id, "changesets:read");
    const record = await getChangeset(id, changesetId, actor);
    return record ? NextResponse.json({ apiVersion: 1, record }) : NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  } catch (error) { return sourceFailure(error); }
}

import { NextRequest, NextResponse } from "next/server";
import { requireRepositoryAccess, sourceFailure } from "@/source-control/http";
import { getTree } from "@/source-control/service";
export const runtime = "nodejs";
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; changesetId: string }> }) {
  try {
    const { id, changesetId } = await params;
    const { actor } = await requireRepositoryAccess(req, id, "changesets:read");
    return NextResponse.json({ apiVersion: 1, ...(await getTree(id, changesetId, actor)) });
  } catch (error) { return sourceFailure(error); }
}

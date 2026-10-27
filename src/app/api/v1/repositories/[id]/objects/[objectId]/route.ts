import { NextRequest, NextResponse } from "next/server";
import { requireRepositoryAccess, sourceFailure } from "@/source-control/http";
import { getObject } from "@/source-control/service";
export const runtime = "nodejs";
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; objectId: string }> }) {
  try {
    const { id, objectId } = await params;
    const { actor } = await requireRepositoryAccess(req, id, "changesets:read");
    return NextResponse.json({ apiVersion: 1, ...(await getObject(id, objectId, actor)) });
  } catch (error) { return sourceFailure(error); }
}

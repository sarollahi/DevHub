import { NextRequest, NextResponse } from "next/server";
import { requireRepositoryAccess, sourceFailure } from "@/source-control/http";
import { getObject } from "@/source-control/service";
export const runtime = "nodejs";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string; objectId: string }> }) {
  try {
    const { id, objectId } = await params;
    await requireRepositoryAccess(request, id, "changesets:read");
    return NextResponse.json({ apiVersion: 2, ...(await getObject(id, objectId)) });
  } catch (error) { return sourceFailure(error); }
}

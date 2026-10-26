import { NextRequest, NextResponse } from "next/server";
import { requireRepositoryAccess, sourceFailure } from "@/source-control/http";
import { getCanonicalSnapshot } from "@/source-control/canonical";
export const runtime = "nodejs";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string; changesetId: string }> }) {
  try {
    const { id, changesetId } = await params;
    await requireRepositoryAccess(request, id, "changesets:read");
    return NextResponse.json({ apiVersion: 2, ...(await getCanonicalSnapshot(id, changesetId)) });
  } catch (error) { return sourceFailure(error); }
}

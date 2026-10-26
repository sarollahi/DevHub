import { NextRequest, NextResponse } from "next/server";
import { requireRepositoryAccess, sourceFailure } from "@/source-control/http";
import { findReadableObject, verifyBlob } from "@/object-store/service";
export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; objectId: string }> }) {
  try {
    const { id, objectId } = await params;
    await requireRepositoryAccess(req, id, "changesets:write");
    const record = await findReadableObject(id, objectId);
    await verifyBlob(record);
    return NextResponse.json({ id: record.id, verified: true, rawBytes: record.rawBytes.toString() });
  } catch (error) { return sourceFailure(error); }
}

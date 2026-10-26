import { NextRequest, NextResponse } from "next/server";
import { Readable } from "node:stream";
import { requireRepositoryAccess, sourceFailure } from "@/source-control/http";
import { findReadableObject, verifiedBlobStream } from "@/object-store/service";
export const runtime = "nodejs";
export const maxDuration = 300;

// Consumers MUST validate the final SHA-256: a streaming integrity error can arrive
// after response headers and earlier chunks have already been transmitted.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; objectId: string }> }) {
  try {
    const { id, objectId } = await params;
    await requireRepositoryAccess(req, id, "changesets:read");
    const record = await findReadableObject(id, objectId);
    const stream = await verifiedBlobStream(record);
    return new NextResponse(Readable.toWeb(stream) as ReadableStream, {
      headers: {
        "content-type": "application/octet-stream",
        "cache-control": "private, no-store",
        "x-object-id": record.id,
        "x-uncompressed-length": record.rawBytes.toString(),
        "x-content-sha256": record.rawSha256,
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) { return sourceFailure(error); }
}

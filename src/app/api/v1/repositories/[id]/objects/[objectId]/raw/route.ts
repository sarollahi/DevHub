import { NextRequest, NextResponse } from "next/server";
import { requireRepositoryAccess, sourceFailure } from "@/source-control/http";
import { getObject } from "@/source-control/service";
import { SourceControlError } from "@/source-control/contracts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Objects are currently capped at 256 KiB by the native writer. This endpoint
// streams fixed-size chunks and never serializes content through JSON.
export async function GET(req: NextRequest, { params }: {
  params: Promise<{ id: string; objectId: string }>,
}) {
  try {
    const { id, objectId } = await params;
    await requireRepositoryAccess(req, id, "changesets:read");
    const object = await getObject(id, objectId);
    if (object.kind !== "BLOB") throw new SourceControlError(415, "NOT_A_BLOB", "Raw byte streaming requires a blob object");
    const bytes = Buffer.from(object.dataBase64, "base64");
    let offset = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.length) { controller.close(); return; }
        const end = Math.min(offset + 64 * 1024, bytes.length);
        controller.enqueue(bytes.subarray(offset, end));
        offset = end;
      },
    });
    return new NextResponse(stream, { headers: {
      "content-type": "application/octet-stream",
      "content-disposition": "attachment",
      "content-length": String(bytes.length),
      "etag": `"${object.id}"`,
      "cache-control": "private, immutable, max-age=31536000",
      "x-content-type-options": "nosniff",
    } });
  } catch (error) { return sourceFailure(error); }
}

import { Readable } from "node:stream";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/prisma";
import { requireRepositoryAccess, sourceFailure } from "@/source-control/http";
import { SourceControlError } from "@/source-control/contracts";
import { objectId } from "@/source-control/storage";
import { findReadableObject, verifiedBlobStream } from "@/object-store/service";
export const runtime = "nodejs";

export async function GET(request: NextRequest, { params }: {
  params: Promise<{ id: string; objectId: string }>
}) {
  try {
    const { id: repositoryId, objectId: id } = await params;
    await requireRepositoryAccess(request, repositoryId, "changesets:read");
    const referenced = await db.sourceFileOperation.findFirst({ where: {
      objectId: id, changeset: { repositoryId },
    }, select: { changesetId: true } });
    if (!referenced) throw new SourceControlError(404, "NOT_FOUND", "Object not found in repository history");
    const blob = await db.sourceObject.findUnique({ where: { id } });
    if (!blob || blob.kind !== "BLOB") throw new SourceControlError(404, "NOT_FOUND", "Object not found");
    if (blob.data !== null) {
      if (objectId("BLOB", blob.data) !== id) throw new Error("Native blob integrity check failed");
      return new NextResponse(new Uint8Array(blob.data), { headers: {
        "content-type": "application/octet-stream", "content-length": String(blob.byteSize),
        "x-content-sha256": id, "cache-control": "private, no-store",
      } });
    }
    if (blob.externalId !== id) throw new Error("Native blob missing external storage identity");
    const record = await findReadableObject(repositoryId, id);
    const content = await verifiedBlobStream(record);
    return new NextResponse(Readable.toWeb(content) as ReadableStream, { headers: {
      "content-type": "application/octet-stream",
      "content-length": String(record.rawBytes),
      "x-content-sha256": id, "cache-control": "private, no-store",
    } });
  } catch (error) { return sourceFailure(error); }
}

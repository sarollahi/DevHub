import { Readable } from "node:stream";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/prisma";
import { assertRepositoryPermission } from "@/lib/authorization";
import { resolvePath, runAuthorizedQuery } from "@/source-control/query";
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
    const { actor } = await requireRepositoryAccess(request, repositoryId, "changesets:read");
    const filePath = request.nextUrl.searchParams.get("path");
    const revision = request.nextUrl.searchParams.get("revision");
    if (filePath !== null || revision !== null) {
      if (!filePath || !revision) throw new SourceControlError(422, "INVALID_PATH", "File path and revision required together");
      await assertRepositoryPermission(actor, repositoryId, "source:read", { paths: [filePath] });
      const resolved = await runAuthorizedQuery(actor, repositoryId, () => resolvePath(repositoryId, revision, filePath));
      if (resolved.kind !== "file" || resolved.objectId !== id) throw new SourceControlError(404, "NOT_FOUND", "Object not at the requested revision");
    } else {
      const references = await db.sourceFileOperation.findMany({ where: {
        objectId: id, changeset: { repositoryId },
      }, select: { path: true }, take: 100 });
      if (!references.length) throw new SourceControlError(404, "NOT_FOUND", "Object not found");
      let allowed = false;
      for (const reference of references) {
        try { await assertRepositoryPermission(actor, repositoryId, "source:read", { paths: [reference.path] }); allowed = true; break; }
        catch { /* File-level denial must also apply to direct object URLs. */ }
      }
      if (!allowed) throw new SourceControlError(404, "NOT_FOUND", "Object not found");
    }
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

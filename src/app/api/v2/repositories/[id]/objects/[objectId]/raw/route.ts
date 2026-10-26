import { NextRequest } from "next/server";
import { requireRepositoryAccess, sourceFailure } from "@/source-control/http";
import { getObject } from "@/source-control/service";
import { SourceControlError } from "@/source-control/contracts";
export const runtime = "nodejs";
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; objectId: string }> }) {
  try {
    const { id, objectId } = await params;
    await requireRepositoryAccess(req, id, "changesets:read");
    const blob = await getObject(id, objectId);
    if (blob.kind !== "BLOB") throw new SourceControlError(422, "INVALID_KIND", "Expected blob");
    const data = Buffer.from(blob.dataBase64, "base64");
    const etag = '"' + blob.id + '"';
    const common = { "Accept-Ranges": "bytes", ETag: etag, "Cache-Control": "private, max-age=0, must-revalidate" };
    if (req.headers.get("if-none-match") === etag && !req.headers.has("range")) return new Response(null, { status: 304, headers: common });
    const value = req.headers.get("range");
    const match = value?.match(/^bytes=(\d+)-$/);
    if (value && !match) return new Response(null, { status: 416, headers: { ...common, "Content-Range": `bytes */${data.length}` } });
    const start = match ? Number(match[1]) : 0;
    if (!Number.isSafeInteger(start) || start >= data.length && data.length > 0 ||
      (data.length === 0 && start > 0)) return new Response(null, { status: 416, headers: { ...common, "Content-Range": `bytes */${data.length}` } });
    const offset = req.headers.get("if-range") && req.headers.get("if-range") !== etag ? 0 : start;
    const partial = offset > 0;
    return new Response(new Uint8Array(data.subarray(offset)), { status: partial ? 206 : 200,
      headers: { ...common, "Content-Type": "application/octet-stream", "Content-Length": String(data.length - offset),
        ...(partial ? { "Content-Range": `bytes ${offset}-${data.length - 1}/${data.length}` } : {}) } });
  } catch (error) { return sourceFailure(error); }
}

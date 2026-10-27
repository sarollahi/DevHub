import { NextRequest, NextResponse } from "next/server";
import { requireRepositoryAccess, sourceFailure } from "@/source-control/http";
import { appendUpload } from "@/source-control/uploads";
import { SourceControlError } from "@/source-control/contracts";
export const runtime = "nodejs";
async function readChunk(request: Request) {
  if (Number(request.headers.get("content-length") || "0") > 262144 || !request.body)
    throw new SourceControlError(413, "UPLOAD_TOO_LARGE", "Chunk must be between 1 and 262144 bytes");
  const chunks: Buffer[] = [];
  const reader = request.body.getReader();
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 262144) throw new SourceControlError(413, "UPLOAD_TOO_LARGE", "Chunk exceeds 256 KiB");
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string; objectId: string }> }) {
  try {
    const { id, objectId } = await params;
    await requireRepositoryAccess(req, id, "changesets:write");
    const raw = req.headers.get("upload-offset");
    if (!raw || !/^\d+$/.test(raw)) throw new SourceControlError(422, "INVALID_OFFSET", "Provide numeric Upload-Offset");
    return NextResponse.json({ apiVersion: 2, ...(await appendUpload(id, objectId, Number(raw), await readChunk(req))) });
  } catch (error) { return sourceFailure(error); }
}

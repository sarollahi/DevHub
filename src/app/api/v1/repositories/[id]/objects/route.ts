import { NextRequest, NextResponse } from "next/server";
import { Readable } from "node:stream";
import { requireRepositoryAccess, sourceFailure } from "@/source-control/http";
import { uploadBlob } from "@/object-store/service";
export const runtime = "nodejs";
export const maxDuration = 300;

// Binary request body is consumed once, with Node stream backpressure. Never req.arrayBuffer().
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await requireRepositoryAccess(req, id, "changesets:write");
    if (req.headers.get("content-type")?.split(";")[0] !== "application/octet-stream") {
      return NextResponse.json({ error: "CONTENT_TYPE_REQUIRED" }, { status: 415 });
    }
    if (!req.body) return NextResponse.json({ error: "BODY_REQUIRED" }, { status: 400 });
    const declared = req.headers.get("content-length");
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > 100 * 1024 ** 3)) {
      return NextResponse.json({ error: "OBJECT_TOO_LARGE" }, { status: 413 });
    }
    const input = Readable.from(req.body as unknown as AsyncIterable<Uint8Array>);
    const receipt = await uploadBlob(id, input, req.headers.get("x-expected-object-id"));
    return NextResponse.json({ apiVersion: 1, ...receipt }, { status: receipt.deduplicated ? 200 : 201 });
  } catch (error) { return sourceFailure(error); }
}

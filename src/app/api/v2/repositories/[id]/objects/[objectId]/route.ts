import { NextRequest, NextResponse } from "next/server";
import { requireRepositoryAccess, sourceFailure } from "@/source-control/http";
import { getObject } from "@/source-control/service";
export const runtime = "nodejs";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string; objectId: string }> }) {
  try {
    const { id, objectId } = await params;
    const { actor } = await requireRepositoryAccess(request, id, "changesets:read");
    const object = await getObject(id, objectId, actor);
    if (request.nextUrl.searchParams.get("format") === "raw") {
      const content = Buffer.from(object.dataBase64, "base64");
      return new NextResponse(content, { status: 200, headers: {
        "content-type": "application/octet-stream",
        "content-length": String(content.byteLength),
        "x-devhub-object-kind": object.kind,
        "x-devhub-object-id": object.id,
        "x-content-type-options": "nosniff",
        "cache-control": "private, no-store",
      } });
    }
    return NextResponse.json({ apiVersion: 2, ...object });
  } catch (error) { return sourceFailure(error); }
}

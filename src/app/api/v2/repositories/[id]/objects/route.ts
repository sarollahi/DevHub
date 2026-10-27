import { NextRequest, NextResponse } from "next/server";
import { requireRepositoryAccess, sourceFailure, readBoundedJson } from "@/source-control/http";
import { stageCanonicalBlob } from "@/source-control/canonical";
export const runtime = "nodejs";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { actor } = await requireRepositoryAccess(request, id, "changesets:write");
    // Decode only after checking JSON API size. Large-object uploads require a
    // separately bounded streaming storage endpoint.
    if (Number(request.headers.get("content-length") || "0") > 6_000_000) {
      return NextResponse.json({ error: "REQUEST_TOO_LARGE" }, { status: 413 });
    }
    const body = await readBoundedJson(request, 6_000_000);
    const dataBase64 = body && typeof body === "object" && "dataBase64" in body ? body.dataBase64 : undefined;
    const result = await stageCanonicalBlob(id, actor, dataBase64);
    return NextResponse.json({ apiVersion: 2, ...result }, { status: 201 });
  } catch (error) { return sourceFailure(error); }
}

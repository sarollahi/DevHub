import { NextRequest, NextResponse } from "next/server";
import { requireRepositoryAccess, sourceFailure, readBoundedJson } from "@/source-control/http";
import { createCanonicalChangeset, listCanonicalChangesets } from "@/source-control/canonical";
export const runtime = "nodejs";

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { actor } = await requireRepositoryAccess(request, id, "changesets:write");
    const body = await readBoundedJson(request, 512_000);
    const result = await createCanonicalChangeset(id, actor, body);
    return NextResponse.json({ apiVersion: 2, ...result }, { status: result.created ? 201 : 200 });
  } catch (error) { return sourceFailure(error); }
}
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { actor } = await requireRepositoryAccess(request, id, "changesets:read");
    const limit = Number(request.nextUrl.searchParams.get("limit") ?? 30);
    return NextResponse.json({ apiVersion: 2, records: await listCanonicalChangesets(id, Number.isFinite(limit) ? limit : 30, actor) });
  } catch (error) { return sourceFailure(error); }
}

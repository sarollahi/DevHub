import { NextRequest, NextResponse } from "next/server";
import { requireRepositoryAccess, sourceFailure } from "@/source-control/http";
import { createChangeset, listChangesets } from "@/source-control/service";
export const runtime = "nodejs";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { actor } = await requireRepositoryAccess(req, id, "changesets:write");
    const input = await req.json().catch(() => null);
    const receipt = await createChangeset(id, actor, input);
    return NextResponse.json({ apiVersion: 1, ...receipt }, { status: receipt.created ? 201 : 200 });
  } catch (error) { return sourceFailure(error); }
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await requireRepositoryAccess(req, id, "changesets:read");
    const limit = Number(req.nextUrl.searchParams.get("limit") ?? 30);
    const records = await listChangesets(id, Number.isFinite(limit) ? limit : 30);
    return NextResponse.json({ apiVersion: 1, records });
  } catch (error) { return sourceFailure(error); }
}

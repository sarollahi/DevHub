import { NextRequest, NextResponse } from "next/server";
import { requireRepositoryAccess, sourceFailure } from "@/source-control/http";
import { listCanonicalEvents } from "@/source-control/canonical";
export const runtime = "nodejs";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await requireRepositoryAccess(request, id, "changesets:read");
    const limit = Number(request.nextUrl.searchParams.get("limit") ?? 30);
    return NextResponse.json({ apiVersion: 2, records: await listCanonicalEvents(id, Number.isFinite(limit) ? limit : 30) });
  } catch (error) { return sourceFailure(error); }
}

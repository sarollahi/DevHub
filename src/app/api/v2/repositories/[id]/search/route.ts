import { measured } from "@/observability/telemetry";
import { NextRequest, NextResponse } from "next/server";
import { requireRepositoryAccess, sourceFailure } from "@/source-control/http";
import { searchRepository, type SearchMode } from "@/source-control/search";
import { db } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return measured("query.read", async () => {
  try {
    const { id } = await params;
    const { actor } = await requireRepositoryAccess(request, id, "changesets:read");
    const q = request.nextUrl.searchParams;
    const repo = await db.repository.findUnique({ where: { id }, select: { defaultBranch: true } });
    const result = await searchRepository({ repositoryId: id, actor,
      revision: q.get("revision") || repo?.defaultBranch || "",
      mode: (q.get("mode") || "path") as SearchMode,
      query: q.get("q") || "", cursor: q.get("cursor") || undefined,
      limit: Number(q.get("limit") || "40"),
    });
    return NextResponse.json({ apiVersion: 2, ...result },
      { headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
  } catch (error) { return sourceFailure(error); }
  }, request.headers.get("traceparent"));
}

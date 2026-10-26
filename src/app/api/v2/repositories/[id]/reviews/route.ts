import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/prisma";
import { requireRepositoryAccess, sourceFailure } from "@/source-control/http";
export const runtime = "nodejs";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await requireRepositoryAccess(request, id, "changesets:read");
    const limit = Math.max(1, Math.min(100, Number(request.nextUrl.searchParams.get("limit")) || 40));
    const cursor = request.nextUrl.searchParams.get("cursor");
    const [records, counts, aggregate] = await Promise.all([
      db.sourceReview.findMany({
        where: { repositoryId: id },
        take: limit + 1,
        ...(cursor && /^[a-f0-9]{64}$/.test(cursor) ? { cursor: { changesetId: cursor }, skip: 1 } : {}),
        orderBy: [{ createdAt: "desc" }, { changesetId: "desc" }],
        include: { changeset: { select: { message: true, authorId: true, createdAt: true } } },
      }),
      db.sourceReview.groupBy({ by: ["state"], where: { repositoryId: id }, _count: { _all: true } }),
      db.sourceReview.aggregate({ where: { repositoryId: id, state: "COMPLETED" },
        _avg: { latencyMs: true, confidence: true }, _sum: { costMicros: true },
      }),
    ]);
    return NextResponse.json({
      apiVersion: 2,
      records: records.slice(0, limit).map(r => ({ ...r, costMicros: r.costMicros.toString() })),
      nextCursor: records.length > limit ? records[limit - 1].changesetId : null,
      metrics: { states: counts.map(x => ({ state: x.state, count: x._count._all })),
        averageLatencyMs: aggregate._avg.latencyMs, averageConfidence: aggregate._avg.confidence,
        pricedCostMicros: (aggregate._sum.costMicros ?? 0n).toString() },
    });
  } catch (error) { return sourceFailure(error); }
}

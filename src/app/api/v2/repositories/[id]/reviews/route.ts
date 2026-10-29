import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/prisma";
import { requireRepositoryAccess, sourceFailure, readBoundedJson } from "@/source-control/http";
import { SourceControlError } from "@/source-control/contracts";
export const runtime = "nodejs";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await requireRepositoryAccess(request, id, "changesets:read");
    const limit = Math.max(1, Math.min(100, Number(request.nextUrl.searchParams.get("limit")) || 40));
    const cursor = request.nextUrl.searchParams.get("cursor");
    const risk=request.nextUrl.searchParams.get("risk");
    const state=request.nextUrl.searchParams.get("state");
    const search=request.nextUrl.searchParams.get("q")?.trim().slice(0,100)??"";
    const group=request.nextUrl.searchParams.get("group")?.trim();
    const decision=request.nextUrl.searchParams.get("decision");
    const where:Prisma.SourceReviewWhereInput={repositoryId:id,
      ...(risk&&["LOW","MEDIUM","HIGH","CRITICAL"].includes(risk)?{riskTier:risk as "LOW"|"MEDIUM"|"HIGH"|"CRITICAL"}:{}),
      ...(state&&["QUEUED","RUNNING","COMPLETED","FAILED"].includes(state)?{state:state as "QUEUED"|"RUNNING"|"COMPLETED"|"FAILED"}:{}),
      ...(group&&/^[a-f0-9]{32,64}$/.test(group)?{groupKey:group}:{}),
      ...(decision==="unapproved"?{changeset:{approvals:{none:{decision:"APPROVED"}}}}:{}),
      ...(search?{OR:[{changeset:{message:{contains:search,mode:"insensitive"}}},
        {intervals:{some:{path:{contains:search,mode:"insensitive"}}}}]}:{}),
    };
    const [records,counts,aggregate,modelCalls]=await Promise.all([
      db.sourceReview.findMany({where,take:limit+1,
        ...(cursor&&/^[a-f0-9]{64}$/.test(cursor)?{cursor:{changesetId:cursor},skip:1}:{}),
        orderBy:[{riskScore:"desc"},{createdAt:"desc"},{changesetId:"desc"}],
        include:{changeset:{select:{message:true,authorId:true,createdAt:true,approvals:{select:{decision:true}}}}}}),
      db.sourceReview.groupBy({by:["state"],where:{repositoryId:id},_count:{_all:true}}),
      db.sourceReview.aggregate({where:{repositoryId:id,state:"COMPLETED"},
        _avg:{latencyMs:true,confidence:true},_sum:{costMicros:true}}),
      db.sourceReviewModelCall.groupBy({by:["operation","succeeded"],where:{
        review:{repositoryId:id}},_count:{_all:true},_sum:{costMicros:true}}),
    ]);
    return NextResponse.json({
      apiVersion: 2,
      records: records.slice(0, limit).map(r => ({ ...r, costMicros: r.costMicros.toString() })),
      nextCursor: records.length > limit ? records[limit - 1].changesetId : null,
      metrics: { states: counts.map(x => ({ state: x.state, count: x._count._all })),
        averageLatencyMs: aggregate._avg.latencyMs, averageConfidence: aggregate._avg.confidence,
        pricedCostMicros: (aggregate._sum.costMicros ?? 0n).toString(),
        modelCalls:modelCalls.map(x=>({operation:x.operation,succeeded:x.succeeded,
          count:x._count._all,costMicros:(x._sum.costMicros??0n).toString()})) },
    });
  } catch (error) { return sourceFailure(error); }
}

const input = z.object({
  changesetId: z.string().regex(/^[a-f0-9]{64}$/),
  targetRef: z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/),
  title: z.string().trim().min(1).max(250),
  description: z.string().max(10000).default(""),
}).strict();
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { actor } = await requireRepositoryAccess(req, id, "changesets:write");
    const parsed = input.safeParse(await readBoundedJson(req, 12000));
    if (!parsed.success) throw new SourceControlError(422, "INVALID_INPUT", "Invalid review request");
    const { changesetId, targetRef, title, description } = parsed.data;
    const result = await db.$transaction(async tx => {
      const change = await tx.sourceChangeset.findFirst({ where: { repositoryId: id, id: changesetId } });
      if (!change) throw new SourceControlError(404, "NOT_FOUND", "Changeset not found");
      const key = { repositoryId: id, changesetId, targetRef };
      const existing = await tx.sourceReviewRequest.findUnique({ where: { repositoryId_changesetId_targetRef: key } });
      if (existing) return { review: existing, created: false };
      const review = await tx.sourceReviewRequest.create({ data: { ...key, title, description, actorId: actor.type + ":" + actor.id } });
      await tx.auditEvent.create({ data: { repositoryId: id, actorType: actor.type, actorId: actor.id, action: "native_review.created",
        subjectId: review.id, metadata: { changesetId, targetRef } } });
      return { review, created: true };
    });
    return NextResponse.json({ apiVersion: 2, ...result }, { status: result.created ? 201 : 200 });
  } catch (error) { return sourceFailure(error); }
}

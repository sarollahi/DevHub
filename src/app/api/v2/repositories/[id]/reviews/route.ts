import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/prisma";
import { requireRepositoryAccess, sourceFailure, readBoundedJson } from "@/source-control/http";
import { SourceControlError } from "@/source-control/contracts";
export const runtime = "nodejs";
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
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await requireRepositoryAccess(req, id, "changesets:read");
    const records = await db.sourceReviewRequest.findMany({ where: { repositoryId: id }, orderBy: { createdAt: "desc" }, take: 100 });
    return NextResponse.json({ apiVersion: 2, records });
  } catch (error) { return sourceFailure(error); }
}

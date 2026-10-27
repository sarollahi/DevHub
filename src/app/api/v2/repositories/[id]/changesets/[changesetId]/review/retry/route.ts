import { NextRequest, NextResponse } from "next/server";
import { requireRepositoryAccess, sourceFailure } from "@/source-control/http";
import { SourceControlError } from "@/source-control/contracts";
import { db } from "@/lib/prisma";

export async function POST(request: NextRequest, { params }: {
  params: Promise<{ id: string; changesetId: string }>;
}) {
  try {
    const { id, changesetId } = await params;
    const { ownerId } = await requireRepositoryAccess(request, id, "changesets:approve", true);
    const updated = await db.$transaction(async tx => {
      const result = await tx.sourceReview.updateMany({ where: {
        repositoryId: id, changesetId, state: "FAILED",
      }, data: { state: "QUEUED", attempts: 0, nextAttemptAt: new Date(), leaseUntil: null, error: null } });
      if (result.count) await tx.auditEvent.create({ data: { repositoryId: id, actorType: "HUMAN", actorId: ownerId,
        action: "changeset.review.retried", subjectId: changesetId } });
      return result.count;
    });
    if (!updated) throw new SourceControlError(409, "REVIEW_NOT_FAILED", "Only failed reviews can be retried");
    return NextResponse.json({ changesetId, state: "QUEUED" });
  } catch (error) { return sourceFailure(error); }
}

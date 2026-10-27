import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/prisma";
import { requireRepositoryAccess, sourceFailure, readBoundedJson } from "@/source-control/http";
import { SourceControlError } from "@/source-control/contracts";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string; changesetId: string }> };
const decision = z.object({
  expectedChangesetId: z.string().regex(/^[0-9a-f]{64}$/),
  decision: z.enum(["APPROVED", "CHANGES_REQUESTED"]),
}).strict();

export async function GET(request: NextRequest, { params }: Context) {
  try {
    const { id, changesetId } = await params;
    await requireRepositoryAccess(request, id, "changesets:read");
    const record = await db.sourceReview.findFirst({ where: { repositoryId: id, changesetId },
      include: { changeset: { select: {
        id: true, authorId: true, message: true, createdAt: true,
        operations: { orderBy: { position: "asc" } },
        validation: true, approvals: true,
      } } },
    });
    if (!record) throw new SourceControlError(404, "NOT_FOUND", "Review not found");
    return NextResponse.json({ apiVersion: 2, record: { ...record, costMicros: record.costMicros.toString() } });
  } catch (error) { return sourceFailure(error); }
}

export async function POST(request: NextRequest, { params }: Context) {
  try {
    const { id, changesetId } = await params;
    const { ownerId } = await requireRepositoryAccess(request, id, "changesets:approve", true);
    const input = decision.safeParse(await readBoundedJson(request, 2048));
    if (!input.success) throw new SourceControlError(422, "INVALID_DECISION", "A decision and exact changeset ID are required");
    if (input.data.expectedChangesetId !== changesetId)
      throw new SourceControlError(409, "STALE_CHANGESET", "Decision does not match the reviewed immutable revision");
    const result = await db.$transaction(async tx => {
      const change = await tx.sourceChangeset.findFirst({ where: { id: changesetId, repositoryId: id },
        include: { validation: true, review: true } });
      if (!change) throw new SourceControlError(404, "NOT_FOUND", "Changeset not found in repository");
      if (input.data.decision === "APPROVED" && (
        change.validation?.state !== "SUCCESS" || change.review?.state !== "COMPLETED"
      )) throw new SourceControlError(409, "REVIEW_INCOMPLETE", "Integrity checks and native analysis must finish before approval");
      await tx.sourceChangeApproval.upsert({ where: { changesetId_userId: { changesetId, userId: ownerId } },
        create: { changesetId, userId: ownerId, decision: input.data.decision },
        update: { decision: input.data.decision, createdAt: new Date() },
      });
      await tx.auditEvent.create({ data: { repositoryId: id, actorType: "HUMAN", actorId: ownerId,
        action: input.data.decision === "APPROVED" ? "changeset.review.approved" : "changeset.review.changes_requested",
        subjectId: changesetId,
        metadata: { changesetId, reviewedFingerprint: change.review?.fingerprint ?? null,
          riskTier: change.review?.riskTier ?? null },
      } });
      return { changesetId, decision: input.data.decision };
    });
    return NextResponse.json({ apiVersion: 2, ...result });
  } catch (error) { return sourceFailure(error); }
}

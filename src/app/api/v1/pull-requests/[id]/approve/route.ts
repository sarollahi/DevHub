import { NextRequest, NextResponse } from "next/server";
import { isAdminRequest, verifyBrowserOrigin } from "@/lib/auth";
import { db } from "@/lib/prisma";
import { canApprove } from "@/lib/review-logic";
import { hasVerifiedChecks } from "@/validation/service";
export const runtime = "nodejs";
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAdminRequest(req))) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  if (!req.headers.get("authorization") && !verifyBrowserOrigin(req)) return NextResponse.json({ error: "INVALID_ORIGIN" }, { status: 403 });
  const { id } = await params;
  const source = await db.pullRequest.findUnique({ where: { id },
    select: { nativeChangesetId: true, repositoryId: true } });
  if (!source) return NextResponse.json({status:"NOT_FOUND"},{status:404});
  if (!source.nativeChangesetId || !(await hasVerifiedChecks(source.repositoryId, source.nativeChangesetId, null))) {
    return NextResponse.json({status:"EXECUTION_VALIDATION_REQUIRED"},{status:409});
  }
  const result = await db.$transaction(async (tx) => {
    const pr = await tx.pullRequest.findUnique({ where: { id }, include: { checks: true, repository: true } });
    if (!pr) return "NOT_FOUND";
    await tx.$queryRaw`SELECT id FROM "PullRequest" WHERE id = ${id}::uuid FOR UPDATE`;
    const last = await tx.pullRequest.findUniqueOrThrow({ where: { id }, include: { checks: true } });
    if (last.nativeChangesetId !== source.nativeChangesetId || !canApprove(last.state, last.checks.map((c) => c.state), true)) return "CHECKS_OR_STATE_NOT_READY";
    const ownerId = pr.repository.ownerId;
    await tx.approval.upsert({ where: { pullId_userId_version: { pullId: id, userId: ownerId, version: last.version } },
      create: { pullId: id, userId: ownerId, version: last.version, decision: "APPROVED" },
      update: { decision: "APPROVED" } });
    await tx.pullRequest.update({ where: { id }, data: { state: "APPROVED", approvedAt: new Date() } });
    await tx.auditEvent.create({ data: { repositoryId: pr.repositoryId, actorType: "HUMAN", actorId: ownerId,
      action: "pull_request.approved", subjectId: id, metadata: { version: last.version } } });
    return "APPROVED";
  });
  return NextResponse.json({ status: result }, { status: result === "APPROVED" ? 200 : result === "NOT_FOUND" ? 404 : 409 });
}

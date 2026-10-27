import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/prisma";
import { requireHuman, assertRepoAdmin, auditIdentity } from "@/lib/identity-management";
import { sourceFailure } from "@/source-control/http";
import { SourceControlError } from "@/source-control/contracts";
export async function DELETE(request: NextRequest, { params }: {
  params: Promise<{ id: string; delegationId: string }> }) {
  try {
    const actor = await requireHuman(request, true);
    const { id, delegationId } = await params;
    await db.$transaction(async tx => {
      await assertRepoAdmin(actor.id, id, tx);
      const updated = await tx.agentDelegation.updateMany({ where: { id: delegationId, repositoryId: id, revokedAt: null },
        data: { revokedAt: new Date() } });
      if (!updated.count) throw new SourceControlError(404, "NOT_FOUND", "Active delegation not found");
      await auditIdentity(tx, actor.id, "agent.delegation.revoked", delegationId, id);
    });
    return NextResponse.json({ revoked: true });
  } catch (error) { return sourceFailure(error); }
}

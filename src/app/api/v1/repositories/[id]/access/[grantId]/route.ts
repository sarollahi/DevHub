import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/prisma";
import { requireHuman, assertRepoAdmin, auditIdentity } from "@/lib/identity-management";
import { sourceFailure } from "@/source-control/http";
import { SourceControlError } from "@/source-control/contracts";
export async function DELETE(request: NextRequest, { params }: {
  params: Promise<{ id: string; grantId: string }> }) {
  try {
    const actor = await requireHuman(request, true);
    const { id, grantId } = await params;
    await db.$transaction(async tx => {
      await assertRepoAdmin(actor.id, id, tx);
      const result = await tx.repositoryGrant.deleteMany({ where: { id: grantId, repositoryId: id } });
      if (!result.count) throw new SourceControlError(404, "NOT_FOUND", "Grant not found");
      await auditIdentity(tx, actor.id, "repository.grant.deleted", grantId, id);
    });
    return NextResponse.json({ revoked: true });
  } catch (error) { return sourceFailure(error); }
}

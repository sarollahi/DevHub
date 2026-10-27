import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/prisma";
import { requireHuman, auditIdentity } from "@/lib/identity-management";
import { sourceFailure } from "@/source-control/http";
import { SourceControlError } from "@/source-control/contracts";
export async function DELETE(request: NextRequest, { params }: {
  params: Promise<{ id: string; credentialId: string }> }) {
  try {
    const actor = await requireHuman(request, true);
    const { id, credentialId } = await params;
    await db.$transaction(async tx => {
      const agent = await tx.agentIdentity.findFirst({ where: { id, ownerId: actor.id } });
      if (!agent) throw new SourceControlError(404, "NOT_FOUND", "Machine not found");
      const revoked = await tx.agentCredential.updateMany({
        where: { id: credentialId, agentId: id, revokedAt: null }, data: { revokedAt: new Date() },
      });
      if (!revoked.count) throw new SourceControlError(404, "NOT_FOUND", "Active credential not found");
      await auditIdentity(tx, actor.id, "credential.revoked", credentialId, undefined, { machineId: id });
    });
    return NextResponse.json({ revoked: true });
  } catch (error) { return sourceFailure(error); }
}

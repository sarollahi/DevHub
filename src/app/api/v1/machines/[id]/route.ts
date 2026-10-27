import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/prisma";
import { requireHuman, auditIdentity } from "@/lib/identity-management";
import { sourceFailure, readBoundedJson } from "@/source-control/http";
import { SourceControlError } from "@/source-control/contracts";
const schema = z.object({ status: z.enum(["ACTIVE", "SUSPENDED", "REVOKED"]) }).strict();
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireHuman(request, true);
    const { id } = await params;
    const { status } = schema.parse(await readBoundedJson(request, 16_384));
    const machine = await db.$transaction(async tx => {
      const original = await tx.agentIdentity.findFirst({ where: { id, ownerId: actor.id } });
      if (!original) throw new SourceControlError(404, "NOT_FOUND", "Machine not found");
      if (original.status === "REVOKED" && status !== "REVOKED") {
        throw new SourceControlError(403, "PERMANENT_REVOCATION", "Revoked machines cannot be reactivated");
      }
      const result = await tx.agentIdentity.update({ where: { id }, data: { status } });
      if (status === "REVOKED") await tx.agentCredential.updateMany({
        where: { agentId: id, revokedAt: null }, data: { revokedAt: new Date() },
      });
      await auditIdentity(tx, actor.id, "machine.status.updated", id, undefined, { status });
      return result;
    });
    return NextResponse.json({ machine: { id: machine.id, status: machine.status } });
  } catch (error) { return sourceFailure(error); }
}

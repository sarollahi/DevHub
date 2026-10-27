import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/prisma";
import { requireHuman, requireOrgAdministrator, requireMembership, auditIdentity } from "@/lib/identity-management";
import { sourceFailure, readBoundedJson } from "@/source-control/http";
import { SourceControlError } from "@/source-control/contracts";
type Context = { params: Promise<{ id: string; teamId: string }> };
const schema = z.object({ userId: z.string().uuid() }).strict();
async function mutate(request: NextRequest, context: Context, remove: boolean) {
  try {
    const actor = await requireHuman(request, true);
    const { id, teamId } = await context.params;
    const { userId } = schema.parse(await readBoundedJson(request, 16_384));
    await db.$transaction(async tx => {
      await requireOrgAdministrator(actor.id, id, tx);
      const team = await tx.team.findFirst({ where: { id: teamId, organizationId: id } });
      if (!team) throw new SourceControlError(404, "NOT_FOUND", "Team not found");
      if (remove) await tx.teamMembership.deleteMany({ where: { teamId, userId } });
      else {
        await requireMembership(userId, id, tx);
        await tx.teamMembership.upsert({ where: { teamId_userId: { teamId, userId } },
          create: { teamId, userId }, update: {} });
      }
      await auditIdentity(tx, actor.id, remove ? "team.member.removed" : "team.member.added", userId,
        undefined, { organizationId: id, teamId });
    });
    return NextResponse.json({ success: true });
  } catch (error) { return sourceFailure(error); }
}
export const POST = (request: NextRequest, context: Context) => mutate(request, context, false);
export const DELETE = (request: NextRequest, context: Context) => mutate(request, context, true);

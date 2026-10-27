import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/prisma";
import { requireHuman, requireMembership, requireOrgAdministrator, auditIdentity } from "@/lib/identity-management";
import { sourceFailure, readBoundedJson } from "@/source-control/http";
import { SourceControlError } from "@/source-control/contracts";

type Context = { params: Promise<{ id: string }> };
const input = z.object({ userId: z.string().uuid(), role: z.enum(["MEMBER", "ADMIN", "OWNER"]) }).strict();

export async function GET(request: NextRequest, { params }: Context) {
  try {
    const actor = await requireHuman(request);
    const { id } = await params;
    await requireMembership(actor.id, id);
    const members = await db.organizationMembership.findMany({ where: { organizationId: id },
      select: { userId: true, role: true, joinedAt: true, user: { select: { handle: true, email: true } } } });
    return NextResponse.json({ members });
  } catch (error) { return sourceFailure(error); }
}
export async function POST(request: NextRequest, { params }: Context) {
  try {
    const actor = await requireHuman(request, true);
    const { id } = await params;
    const { userId, role } = input.parse(await readBoundedJson(request, 16_384));
    const result = await db.$transaction(async tx => {
      const admin = await requireOrgAdministrator(actor.id, id, tx);
      if (role === "OWNER" && admin.role !== "OWNER") throw new SourceControlError(403, "OWNER_REQUIRED", "Only owners can appoint owners");
      const target = await tx.user.findUnique({ where: { id: userId }, select: { id: true, disabledAt: true } });
      if (!target || target.disabledAt) throw new SourceControlError(404, "USER_NOT_FOUND", "Provisioned user not found");
      const previous = await tx.organizationMembership.findUnique({ where: {
        organizationId_userId: { organizationId: id, userId },
      } });
      if (previous?.role === "OWNER" && role !== "OWNER") {
        const owners = await tx.organizationMembership.count({ where: { organizationId: id, role: "OWNER" } });
        if (owners <= 1 || admin.role !== "OWNER") throw new SourceControlError(403, "OWNER_REQUIRED", "Cannot remove last owner");
      }
      const saved = await tx.organizationMembership.upsert({
        where: { organizationId_userId: { organizationId: id, userId } },
        create: { organizationId: id, userId, role }, update: { role },
      });
      await auditIdentity(tx, actor.id, "organization.membership.updated", userId, undefined, { organizationId: id, role });
      return saved;
    });
    return NextResponse.json({ membership: result });
  } catch (error) { return sourceFailure(error); }
}

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/prisma";
import { requireHuman, requireMembership, requireOrgAdministrator, auditIdentity } from "@/lib/identity-management";
import { sourceFailure, readBoundedJson } from "@/source-control/http";
type Context = { params: Promise<{ id: string }> };
const input = z.object({ slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  name: z.string().trim().min(1).max(120) }).strict();
export async function GET(request: NextRequest, { params }: Context) {
  try {
    const actor = await requireHuman(request);
    const { id } = await params;
    await requireMembership(actor.id, id);
    return NextResponse.json({ teams: await db.team.findMany({ where: { organizationId: id }, include: {
      members: { select: { userId: true } } }, orderBy: { name: "asc" } }) });
  } catch (error) { return sourceFailure(error); }
}
export async function POST(request: NextRequest, { params }: Context) {
  try {
    const actor = await requireHuman(request, true);
    const { id } = await params;
    const fields = input.parse(await readBoundedJson(request, 16_384));
    const team = await db.$transaction(async tx => {
      await requireOrgAdministrator(actor.id, id, tx);
      const result = await tx.team.create({ data: { organizationId: id, ...fields } });
      await auditIdentity(tx, actor.id, "team.created", result.id);
      return result;
    });
    return NextResponse.json({ team }, { status: 201 });
  } catch (error) { return sourceFailure(error); }
}

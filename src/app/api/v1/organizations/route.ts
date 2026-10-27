import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/prisma";
import { requireHuman, auditIdentity } from "@/lib/identity-management";
import { sourceFailure, readBoundedJson } from "@/source-control/http";

const input = z.object({ slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  name: z.string().trim().min(2).max(120) }).strict();

export async function GET(request: NextRequest) {
  try {
    const actor = await requireHuman(request);
    const memberships = await db.organizationMembership.findMany({
      where: { userId: actor.id }, include: { organization: true },
      orderBy: { joinedAt: "asc" },
    });
    return NextResponse.json({ organizations: memberships.map(m => ({ ...m.organization, role: m.role })) });
  } catch (error) { return sourceFailure(error); }
}
export async function POST(request: NextRequest) {
  try {
    const actor = await requireHuman(request, true);
    const parsed = input.parse(await readBoundedJson(request, 16_384));
    const org = await db.$transaction(async tx => {
      const created = await tx.organization.create({ data: { ...parsed } });
      await tx.organizationMembership.create({ data: { organizationId: created.id, userId: actor.id, role: "OWNER" } });
      await auditIdentity(tx, actor.id, "organization.created", created.id);
      return created;
    });
    return NextResponse.json({ organization: org }, { status: 201 });
  } catch (error) { return sourceFailure(error); }
}

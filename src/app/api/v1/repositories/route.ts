import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/prisma";
import { requireHuman, requireOrgAdministrator, auditIdentity } from "@/lib/identity-management";
import { sourceFailure, readBoundedJson } from "@/source-control/http";
import { SourceControlError } from "@/source-control/contracts";
const schema = z.object({ organizationId: z.string().uuid(),
  slug: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,99}$/),
  name: z.string().trim().min(2).max(120) }).strict();
export async function GET(request: NextRequest) {
  try {
    const actor = await requireHuman(request);
    return NextResponse.json({ repositories: await db.repository.findMany({
      where: { OR: [ { ownerId: actor.id, organizationId: null },
        { organization: { memberships: { some: { userId: actor.id } } } } ] },
      select: { id: true, slug: true, name: true, organizationId: true, defaultBranch: true },
      orderBy: { createdAt: "desc" },
    }) });
  } catch (error) { return sourceFailure(error); }
}
export async function POST(request: NextRequest) {
  try {
    const actor = await requireHuman(request, true);
    const values = schema.parse(await readBoundedJson(request, 16_384));
    const repository = await db.$transaction(async tx => {
      await requireOrgAdministrator(actor.id, values.organizationId, tx);
      const org = await tx.organization.findUniqueOrThrow({ where: { id: values.organizationId } });
      const count = await tx.repository.count({ where: { organizationId: values.organizationId } });
      if (count >= org.maxRepositories) throw new SourceControlError(429, "REPOSITORY_QUOTA", "Organization repository quota reached");
      const result = await tx.repository.create({ data: {
        ownerId: actor.id, organizationId: values.organizationId, slug: values.slug,
        name: values.name, requireHumanApproval: true,
      } });
      await auditIdentity(tx, actor.id, "repository.created", result.id, result.id);
      return result;
    });
    return NextResponse.json({ repository }, { status: 201 });
  } catch (error) { return sourceFailure(error); }
}

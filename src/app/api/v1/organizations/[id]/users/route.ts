import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/prisma";
import { passwordDigest } from "@/lib/auth";
import { requireHuman, requireOrgAdministrator, auditIdentity } from "@/lib/identity-management";
import { readBoundedJson, sourceFailure } from "@/source-control/http";

const schema = z.object({
  handle: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{2,39}$/),
  email: z.email().max(254).transform(s => s.trim().toLowerCase()),
  password: z.string().min(12).max(256),
  role: z.enum(["MEMBER", "ADMIN"]).default("MEMBER"),
}).strict();

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireHuman(request, true);
    const { id } = await params;
    const data = schema.parse(await readBoundedJson(request, 16_384));
    const user = await db.$transaction(async tx => {
      await requireOrgAdministrator(actor.id, id, tx);
      const created = await tx.user.create({ data: {
        handle: data.handle, email: data.email, passwordHash: passwordDigest(data.password),
      } });
      await tx.organizationMembership.create({ data: {
        organizationId: id, userId: created.id, role: data.role,
      } });
      await auditIdentity(tx, actor.id, "user.provisioned", created.id, undefined, { organizationId: id });
      return created;
    });
    return NextResponse.json({ user: { id: user.id, handle: user.handle, email: user.email } }, { status: 201 });
  } catch (error) { return sourceFailure(error); }
}

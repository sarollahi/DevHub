import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/prisma";
import { requireHuman, auditIdentity } from "@/lib/identity-management";
import { sourceFailure, readBoundedJson } from "@/source-control/http";

const capability = z.enum(["source:read", "changeset:write", "ref:update"]);
const schema = z.object({ name: z.string().trim().min(2).max(80),
  scopes: z.array(capability).min(1).max(3) }).strict();

export async function GET(request: NextRequest) {
  try {
    const actor = await requireHuman(request);
    return NextResponse.json({ machines: await db.agentIdentity.findMany({
      where: { ownerId: actor.id }, select: {
        id: true, name: true, status: true, scopes: true, createdAt: true,
        credentials: { select: { id: true, label: true, scopes: true, expiresAt: true, revokedAt: true,
          createdAt: true } },
      }, orderBy: { createdAt: "desc" },
    }) });
  } catch (error) { return sourceFailure(error); }
}
export async function POST(request: NextRequest) {
  try {
    const actor = await requireHuman(request, true);
    const values = schema.parse(await readBoundedJson(request, 16_384));
    const machine = await db.$transaction(async tx => {
      const result = await tx.agentIdentity.create({ data: {
        ownerId: actor.id, name: values.name, scopes: values.scopes,
      } });
      await auditIdentity(tx, actor.id, "machine.created", result.id);
      return result;
    });
    return NextResponse.json({ machine }, { status: 201 });
  } catch (error) { return sourceFailure(error); }
}

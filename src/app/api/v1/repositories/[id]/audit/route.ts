import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/prisma";
import { requireHuman, assertRepoAdmin } from "@/lib/identity-management";
import { sourceFailure } from "@/source-control/http";
export async function GET(request: NextRequest, { params }: {
  params: Promise<{ id: string }> }) {
  try {
    const actor = await requireHuman(request);
    const { id } = await params;
    await assertRepoAdmin(actor.id, id);
    const records = await db.auditEvent.findMany({ where: { repositoryId: id },
      take: 100, orderBy: { occurredAt: "desc" } });
    return NextResponse.json({ records });
  } catch (error) { return sourceFailure(error); }
}

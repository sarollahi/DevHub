import { NextRequest, NextResponse } from "next/server";
import { requireRepositoryAccess, sourceFailure } from "@/source-control/http";
import { db } from "@/lib/prisma";
export const runtime = "nodejs";
export async function DELETE(request: NextRequest, { params }: {
  params: Promise<{ id: string; credentialId: string }>,
}) {
  try {
    const { id, credentialId } = await params;
    const { actor } = await requireRepositoryAccess(request, id, "source:read", true);
    const result = await db.gitInteropCredential.updateMany({ where: {
      id: credentialId, repositoryId: id, userId: actor.id, revokedAt: null,
    }, data: { revokedAt: new Date() } });
    return NextResponse.json({ apiVersion: 2, revoked: result.count > 0 });
  } catch (error) { return sourceFailure(error); }
}

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/prisma";
import { requireRepositoryAccess, sourceFailure } from "@/source-control/http";
export const runtime = "nodejs";
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await requireRepositoryAccess(req, id, "changesets:read");
    return NextResponse.json({ apiVersion: 1, records: await db.sourceReference.findMany({
      where: { repositoryId: id }, orderBy: { name: "asc" },
    }) });
  } catch (error) { return sourceFailure(error); }
}

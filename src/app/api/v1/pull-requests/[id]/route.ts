import { NextRequest, NextResponse } from "next/server";
import { isAdminRequest } from "@/lib/auth";
import { db } from "@/lib/prisma";
export const runtime = "nodejs";
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isAdminRequest(request))) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  const { id } = await params;
  const item = await db.pullRequest.findUnique({ where: { id }, include: { checks: true, fingerprints: true } });
  if (!item) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  const validation = item.nativeChangesetId ? await db.validationPipeline.findFirst({
    where: { repositoryId:item.repositoryId, changesetId:item.nativeChangesetId,
      targetChangesetId:null }, orderBy:{createdAt:"desc"},
    include:{tasks:{select:{id:true,kind:true,state:true,summary:true,
      fingerprint:true,finishedAt:true,signature:true}}}
  }) : null;
  return NextResponse.json({ ...item, executableValidation:validation });
}

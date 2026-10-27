import { NextRequest, NextResponse } from "next/server";
import { requestIdentity } from "@/lib/auth";
import { assertRepositoryPermission } from "@/lib/authorization";
import { sourceFailure } from "@/source-control/http";
import { SourceControlError } from "@/source-control/contracts";
import { db } from "@/lib/prisma";
export const runtime = "nodejs";
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const actor = await requestIdentity(request);
  if (!actor) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  const { id } = await params;
  const item = await db.pullRequest.findUnique({ where: { id }, include: { checks: true, fingerprints: true } });
  if (!item) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  try {
    await assertRepositoryPermission(actor, item.repositoryId, "source:read");
    if (actor.type === "AGENT" && item.agentId !== actor.id) throw new SourceControlError(403, "ACCESS_DENIED", "Not your contribution");
  } catch (error) { return sourceFailure(error); }
  const validation = item.nativeChangesetId ? await db.validationPipeline.findFirst({
    where: { repositoryId:item.repositoryId, changesetId:item.nativeChangesetId,
      targetChangesetId:null }, orderBy:{createdAt:"desc"},
    include:{tasks:{select:{id:true,kind:true,state:true,summary:true,
      fingerprint:true,finishedAt:true,signature:true}}}
  }) : null;
  return NextResponse.json({ ...item, executableValidation: validation });
}

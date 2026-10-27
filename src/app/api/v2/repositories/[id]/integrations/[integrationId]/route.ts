import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/prisma";
import { SourceControlError } from "@/source-control/contracts";
import { requireRepositoryAccess, sourceFailure } from "@/source-control/http";
export const runtime="nodejs";
export async function GET(request: NextRequest,
  { params }: { params: Promise<{ id:string; integrationId:string }> }) {
  try {
    const { id,integrationId } = await params;
    await requireRepositoryAccess(request,id,"changesets:read");
    const record = await db.changeIntegration.findFirst({where:{id:integrationId,repositoryId:id}});
    if (!record) throw new SourceControlError(404,"NOT_FOUND","Integration not found");
    const audits=await db.auditEvent.findMany({where:{
      repositoryId:id,subjectId:integrationId, action:{startsWith:"integration."},
    },orderBy:{occurredAt:"asc"},take:100});
    return NextResponse.json({apiVersion:2,record,audits});
  }catch(error){return sourceFailure(error);}
}

import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { enqueueIntegration } from "@/integration/service";
import { db } from "@/lib/prisma";
import { SourceControlError } from "@/source-control/contracts";
import { requireRepositoryAccess, sourceFailure, readBoundedJson } from "@/source-control/http";
export const runtime="nodejs";
const schema=z.object({requestKey:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/).optional()}).strict();
export async function POST(request:NextRequest,{params}:{params:Promise<{id:string;integrationId:string}>}){
 try{
  const {id,integrationId}=await params;
  const prior=await db.changeIntegration.findFirst({where:{id:integrationId,repositoryId:id,state:"INTEGRATED"}});
  if(!prior?.resultChangesetId)throw new SourceControlError(409,"NOT_INTEGRATED","Only integrated revisions can be reverted");
  const body=schema.parse(await readBoundedJson(request,2048));
  const {actor}=await requireRepositoryAccess(request,id,"refs:write",false,{branch:prior.targetRef});
  const record=await enqueueIntegration(id,actor,{
    sourceChangesetId:prior.resultChangesetId,targetRef:prior.targetRef,
    requestKey:body.requestKey??"revert-"+randomUUID(),mode:"REVERT",revertIntegrationId:prior.id,
  });
  return NextResponse.json({apiVersion:2,record},{status:202});
 }catch(error){return sourceFailure(error);}
}

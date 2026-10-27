import { NextRequest, NextResponse } from "next/server";
import { reauthorizeIntegration } from "@/integration/service";
import { db } from "@/lib/prisma";
import { SourceControlError } from "@/source-control/contracts";
import { requireRepositoryAccess, sourceFailure } from "@/source-control/http";
export const runtime="nodejs";
export async function POST(request:NextRequest,{params}:{params:Promise<{id:string;integrationId:string}>}){
 try{
  const {id,integrationId}=await params;
  const job=await db.changeIntegration.findFirst({where:{id:integrationId,repositoryId:id}});
  if(!job)throw new SourceControlError(404,"NOT_FOUND","Integration not found");
  const {actor}=await requireRepositoryAccess(request,id,"refs:write",false,{branch:job.targetRef});
  const result=await reauthorizeIntegration(id,integrationId,actor);
  return NextResponse.json({apiVersion:2,record:result});
 }catch(error){return sourceFailure(error);}
}

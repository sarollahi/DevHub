import { NextRequest, NextResponse } from "next/server";
import { requireRepositoryAccess, sourceFailure } from "@/source-control/http";
import { cancelPipeline, pipelineDetail } from "@/validation/service";
export const runtime="nodejs";
type Params={params:Promise<{id:string;runId:string}>};
export async function GET(request:NextRequest,{params}:Params){
  try{
    const {id,runId}=await params;
    await requireRepositoryAccess(request,id,"changesets:read");
    const record=await pipelineDetail(id,runId);
    return record?NextResponse.json({apiVersion:2,record}):
      NextResponse.json({error:"NOT_FOUND"},{status:404});
  }catch(error){return sourceFailure(error);}
}
export async function DELETE(request:NextRequest,{params}:Params){
  try{
    const {id,runId}=await params;
    await requireRepositoryAccess(request,id,"validations:cancel",true);
    await cancelPipeline(id,runId);
    return NextResponse.json({state:"CANCELLED"});
  }catch(error){return sourceFailure(error);}
}

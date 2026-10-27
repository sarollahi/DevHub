import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/prisma";
import { requireRepositoryAccess, sourceFailure } from "@/source-control/http";
import { digest } from "@/validation/policy";
export const runtime="nodejs";
export async function GET(request:NextRequest,{params}:{params:Promise<{
  id:string;runId:string;taskId:string;artifactId:string
}>}){
  try{
    const {id,runId,taskId,artifactId}=await params;
    await requireRepositoryAccess(request,id,"changesets:read");
    const artifact=await db.validationArtifact.findFirst({where:{id:artifactId,taskId,
      task:{pipelineId:runId,pipeline:{repositoryId:id}}}});
    if(!artifact)return NextResponse.json({error:"NOT_FOUND"},{status:404});
    if(digest(artifact.content)!==artifact.digest)
      return NextResponse.json({error:"CORRUPT_ARTIFACT"},{status:409});
    const content=Uint8Array.from(artifact.content);
    return new Response(content,{headers:{"Content-Type":"application/octet-stream",
      "Content-Disposition":"attachment; filename=\"validation-artifact.bin\"",
      "Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff",
      "X-Content-SHA256":artifact.digest}});
  }catch(error){return sourceFailure(error);}
}

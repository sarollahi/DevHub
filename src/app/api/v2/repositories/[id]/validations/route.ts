import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/prisma";
import { requireRepositoryAccess, sourceFailure, readBoundedJson } from "@/source-control/http";
import { submitValidation } from "@/validation/service";
export const runtime="nodejs";
const input=z.object({
  changesetId:z.string().regex(/^[a-f0-9]{64}$/),
  targetChangesetId:z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  idempotencyKey:z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/)
}).strict();
export async function POST(request:NextRequest,{params}:{params:Promise<{id:string}>}) {
  try {
    const {id}=await params;
    const {actor}=await requireRepositoryAccess(request,id,"validations:run");
    const parsed=input.safeParse(await readBoundedJson(request,4096));
    if(!parsed.success)return NextResponse.json({error:"INVALID_INPUT",issues:parsed.error.issues},{status:422});
    const {pipeline,created}=await submitValidation(id,parsed.data.changesetId,
      parsed.data.targetChangesetId||null,parsed.data.idempotencyKey,actor.type+":"+actor.id);
    return NextResponse.json({apiVersion:2,id:pipeline.id,state:pipeline.state,
      statusUrl:"/api/v2/repositories/"+id+"/validations/"+pipeline.id},
      {status:created?202:200});
  } catch(error){return sourceFailure(error);}
}
export async function GET(request:NextRequest,{params}:{params:Promise<{id:string}>}) {
  try {
    const {id}=await params;
    await requireRepositoryAccess(request,id,"changesets:read");
    const changesetId=request.nextUrl.searchParams.get("changesetId");
    if(changesetId&&!/^[a-f0-9]{64}$/.test(changesetId))
      return NextResponse.json({error:"INVALID_CHANGESET"},{status:422});
    const records=await db.validationPipeline.findMany({where:{repositoryId:id,
      ...(changesetId?{changesetId}: {})},orderBy:{createdAt:"desc"},take:50,
      include:{tasks:{select:{id:true,kind:true,state:true,summary:true,attempt:true,
        startedAt:true,finishedAt:true,reusedFromId:true}}}});
    return NextResponse.json({apiVersion:2,records});
  } catch(error){return sourceFailure(error);}
}

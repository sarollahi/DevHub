import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/prisma";
import { requireRepositoryAccess, sourceFailure } from "@/source-control/http";
export const runtime="nodejs";
type Params={params:Promise<{id:string;runId:string;taskId:string}>};
export async function GET(request:NextRequest,{params}:Params){
  try {
    const {id,runId,taskId}=await params;
    await requireRepositoryAccess(request,id,"changesets:read");
    const task=await db.validationTask.findFirst({where:{id:taskId,pipelineId:runId,
      pipeline:{repositoryId:id}},select:{id:true,state:true}});
    if(!task)return NextResponse.json({error:"NOT_FOUND"},{status:404});
    const start=Number(request.nextUrl.searchParams.get("after")||0);
    const startAttempt=Number(request.nextUrl.searchParams.get("afterAttempt")||0);
    if(!Number.isSafeInteger(start)||start<0||!Number.isSafeInteger(startAttempt)||startAttempt<0)return NextResponse.json({error:"INVALID_CURSOR"},{status:422});
    if(request.nextUrl.searchParams.get("stream")!=="1"){
      const chunks=await db.validationLogChunk.findMany({where:{taskId,OR:[{attempt:{gt:startAttempt}},{attempt:startAttempt,sequence:{gt:start}}]},
        orderBy:[{attempt:"asc"},{sequence:"asc"}],take:100});
      return NextResponse.json({chunks});
    }
    const encoder=new TextEncoder();
    const stream=new ReadableStream<Uint8Array>({
      async start(controller) {
        let next=start,attempt=startAttempt;
        for(let tick=0;tick<60&&!request.signal.aborted;tick++){
          try{
            const chunks=await db.validationLogChunk.findMany({where:{taskId,OR:[{attempt:{gt:attempt}},{attempt,sequence:{gt:next}}]},
              orderBy:[{attempt:"asc"},{sequence:"asc"}],take:100});
            for(const c of chunks){
              controller.enqueue(encoder.encode("event: log\ndata: "+JSON.stringify(c)+"\n\n"));
              if(c.attempt!==attempt){attempt=c.attempt;next=0;}
              next=c.sequence;
            }
            const state=await db.validationTask.findUnique({where:{id:taskId},select:{state:true}});
            if(state&&!["RUNNING","QUEUED"].includes(state.state)){
              controller.enqueue(encoder.encode("event: done\ndata: "+JSON.stringify({state:state.state})+"\n\n"));break;
            }
            await new Promise(resolve=>setTimeout(resolve,1000));
          }catch{break;}
        }
        try{controller.close();}catch{}
      }
    });
    return new Response(stream,{headers:{"Content-Type":"text/event-stream; charset=utf-8",
      "Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"}});
  }catch(error){return sourceFailure(error);}
}

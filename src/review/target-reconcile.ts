import { db } from "../lib/prisma";

/**
 * Cursor-based reconciliation of OPEN review targets. Safe across restarts:
 * database state is the checkpoint; scanning from the beginning is idempotent.
 */
export async function reconcileReviewTargets(cursor?:string, batch=100){
  const requests=await db.sourceReviewRequest.findMany({where:{
    status:"OPEN",...(cursor?{id:{gt:cursor}}:{}),
  },orderBy:{id:"asc"},take:Math.max(1,Math.min(200,batch)),
    select:{id:true,repositoryId:true,changesetId:true,targetRef:true,
      lastTargetRevisionId:true,lastTargetCheckedAt:true}});
  if(!requests.length)return {cursor:null as string|null,changed:0,examined:0};
  const refs=await db.sourceReference.findMany({where:{OR:requests.map(r=>({
    repositoryId:r.repositoryId,name:r.targetRef,
  }))},select:{repositoryId:true,name:true,changesetId:true,deletedAt:true}});
  const revisions=new Map(refs.filter(r=>!r.deletedAt).map(r=>[
    r.repositoryId+"\0"+r.name,r.changesetId,
  ]));
  let changed=0;
  for(const request of requests) {
    const target=revisions.get(request.repositoryId+"\0"+request.targetRef)??null;
    if(request.lastTargetCheckedAt && target===request.lastTargetRevisionId)continue;
    await db.$transaction(async tx=>{
      const previous=await tx.sourceReviewRequest.updateMany({where:{
        id:request.id,lastTargetRevisionId:request.lastTargetRevisionId,
      },data:{lastTargetRevisionId:target,lastTargetCheckedAt:new Date()}});
      if(!previous.count)return;
      // Rerun advisory analysis on a new target; do not change stored approvals.
      const updated=await tx.sourceReview.updateMany({where:{
        repositoryId:request.repositoryId,changesetId:request.changesetId,
        state:"COMPLETED",
      },data:{state:"QUEUED",attempts:0,nextAttemptAt:new Date(),indexedAt:null}});
      if(updated.count){
        changed++;
        await tx.auditEvent.create({data:{repositoryId:request.repositoryId,
          actorType:"SYSTEM",actorId:"review-target-reconciler",
          action:"changeset.review.target_moved",subjectId:request.changesetId,
          metadata:{targetRef:request.targetRef,targetRevisionId:target}}});
      }
    });
  }
  return {cursor:requests.length===batch?requests[requests.length-1].id:null,changed,examined:requests.length};
}

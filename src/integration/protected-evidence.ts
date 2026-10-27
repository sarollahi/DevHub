import { Prisma } from "@prisma/client";
import { db } from "../lib/prisma";
import { SourceControlError } from "../source-control/contracts";
import { snapshotFor } from "../validation/snapshot";
import { recipes, configurationDigest, KINDS, verifyTask, fingerprint } from "../validation/policy";

/** Validate and pin signed evidence before a previously unprotected ref becomes protected. */
export async function assertSignedProtectedTip(tx: Prisma.TransactionClient, repositoryId:string, changesetId:string) {
  const change=await tx.sourceChangeset.findFirst({where:{id:changesetId,repositoryId},
    include:{validation:true,review:true}});
  if (!change || change.validation?.state!=="SUCCESS" || change.review?.state!=="COMPLETED")
    throw new SourceControlError(409,"REVIEW_REQUIRED","Protected revisions require complete immutable review");
  await tx.$queryRaw`SELECT "changesetId" FROM "SourceReview" WHERE "changesetId" = ${changesetId} FOR SHARE`;
  await tx.$queryRaw`SELECT "userId" FROM "SourceChangeApproval" WHERE "changesetId" = ${changesetId} FOR SHARE`;
  const review=await tx.sourceReview.findUnique({where:{changesetId}});
  const approval=await tx.sourceChangeApproval.findFirst({where:{changesetId,decision:"APPROVED"}});
  if(review?.state!=="COMPLETED"||!approval)
    throw new SourceControlError(403,"HUMAN_APPROVAL_REQUIRED","Exact protected revision needs completed review and approval");
  let configured;
  try{configured=recipes();}
  catch{throw new SourceControlError(409,"CHECKS_NOT_READY","Pinned validation images are missing");}
  const snapshot=await snapshotFor(repositoryId,changesetId,null);
  const hash=configurationDigest(configured);
  const pipeline=await tx.validationPipeline.findFirst({where:{
    repositoryId,changesetId,targetChangesetId:null,configurationDigest:hash,
    snapshotDigest:snapshot.digest,dependencyDigest:snapshot.dependencyDigest,state:"PASSED",
  },select:{id:true},orderBy:{createdAt:"desc"}});
  if(!pipeline)throw new SourceControlError(409,"CHECKS_NOT_READY","Exact signed execution checks are missing");
  await tx.$queryRaw`SELECT id FROM "ValidationPipeline" WHERE id = ${pipeline.id}::uuid FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM "ValidationTask" WHERE "pipelineId" = ${pipeline.id}::uuid FOR SHARE`;
  const checked=await tx.validationPipeline.findUnique({where:{id:pipeline.id},include:{tasks:true}});
  if(!checked||checked.state!=="PASSED"||checked.configurationDigest!==hash||
     checked.snapshotDigest!==snapshot.digest||checked.dependencyDigest!==snapshot.dependencyDigest||
     checked.tasks.length!==KINDS.length||
     !configured.every(recipe=>{
       const task=checked.tasks.find(t=>t.kind===recipe.kind);
       return !!task&&task.state==="PASSED"&&task.exitCode===0&&verifyTask(task)&&
         task.fingerprint===fingerprint(repositoryId,changesetId,null,
           snapshot.digest,snapshot.dependencyDigest,recipe);
     }))throw new SourceControlError(409,"CHECKS_NOT_READY","Unsigned, failed or stale protection evidence");
  return {pipelineId:checked.id,approvalUserId:approval.userId};
}

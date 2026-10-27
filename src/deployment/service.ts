import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "../lib/prisma";
import { assertRepositoryPermission } from "../lib/authorization";
import { SourceControlError, type SourceActor } from "../source-control/contracts";
import { deploymentGate } from "../integration/service";
import { authenticSignature, getController, sendDeployment, validateReceipt, type Receipt } from "./transport";

type Job = NonNullable<Awaited<ReturnType<typeof db.deploymentExecution.findUnique>>>;
const future = (ms:number) => new Date(Date.now()+ms);
const actorFor = (job:Job): SourceActor => ({id:job.actorId,type:"HUMAN",sessionId:job.actorSessionId});

export async function enqueueDeployment(repositoryId:string,actor:SourceActor,input:{
 integrationId:string; environment:string; requestKey:string;
}) {
 if (actor.type!=="HUMAN" || !actor.sessionId) throw new SourceControlError(403,"HUMAN_REQUIRED","Deployment requires a human admin session");
 if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(input.requestKey))
   throw new SourceControlError(422,"INVALID_KEY","Provide an idempotency key");
 await assertRepositoryPermission(actor,repositoryId,"admin");
 getController(repositoryId,input.environment);
 const gate=await deploymentGate(repositoryId,input.integrationId,actor,true);
 return db.$transaction(async tx=>{
   await assertRepositoryPermission(actor,repositoryId,"admin",{},tx);
   const prior=await tx.deploymentExecution.findUnique({where:{
     repositoryId_environment_requestKey:{repositoryId,environment:input.environment,requestKey:input.requestKey},
   }});
   if(prior){
     if(prior.integrationId!==input.integrationId || prior.revisionId!==gate.revision)
       throw new SourceControlError(409,"IDEMPOTENCY_CONFLICT","Deployment key was used for another revision");
     return prior;
   }
   const active=await tx.deploymentExecution.count({where:{repositoryId,environment:input.environment,
     state:{in:["QUEUED","WAITING_VALIDATION","DISPATCHING","AWAITING_CONFIRMATION"]}}});
   if(active>=12)throw new SourceControlError(429,"DEPLOYMENT_QUOTA","Too many deployments in this environment");
   const record=await tx.deploymentExecution.create({data:{
     repositoryId,integrationId:input.integrationId,environment:input.environment,
     revisionId:gate.revision,requestKey:input.requestKey,
     actorId:actor.id,actorSessionId:actor.sessionId!,
     state:gate.ready?"QUEUED":"WAITING_VALIDATION",
   }});
   await tx.auditEvent.create({data:{repositoryId,actorType:"HUMAN",actorId:actor.id,
     action:"deployment.queued",subjectId:record.id,
     metadata:{integrationId:input.integrationId,revision:gate.revision,environment:input.environment}}});
   return record;
 });
}
export async function receiveReceipt(job:Job,body:string,signed:string|null):Promise<Receipt> {
 const controller=getController(job.repositoryId,job.environment);
 if(!authenticSignature(controller.secret,body,signed)) {
   throw new SourceControlError(403,"INVALID_RECEIPT_SIGNATURE","Controller receipt signature invalid");
 }
 let parsed:unknown;
 try{parsed=JSON.parse(body);}catch{throw new SourceControlError(422,"INVALID_RECEIPT","Invalid JSON receipt");}
 const receipt=validateReceipt(parsed,{id:job.id,revisionId:job.revisionId,environment:job.environment});
 await db.$transaction(async tx=>{
   await tx.$queryRaw`SELECT id FROM "DeploymentExecution" WHERE id = ${job.id}::uuid FOR UPDATE`;
   const current=await tx.deploymentExecution.findUniqueOrThrow({where:{id:job.id}});
   if(["SUCCEEDED","FAILED","STALE_DEPLOYED"].includes(current.state)) {
     if(JSON.stringify(current.receipt)!==JSON.stringify(receipt))
       throw new SourceControlError(409,"RECEIPT_CONFLICT","Already finalized with different signed receipt");
     return;
   }
   if(!["DISPATCHING","AWAITING_CONFIRMATION"].includes(current.state))
     throw new SourceControlError(409,"INVALID_DEPLOYMENT_STATE","Not awaiting controller result");
   const integrated=await tx.changeIntegration.findUniqueOrThrow({where:{id:job.integrationId}});
   const ref=await tx.sourceReference.findUnique({where:{
     repositoryId_name:{repositoryId:job.repositoryId,name:integrated.targetRef},
   }});
   const stale=receipt.state==="SUCCEEDED" &&
     (!ref || ref.deletedAt || ref.changesetId!==job.revisionId);
   const state=stale?"STALE_DEPLOYED":receipt.state==="SUCCEEDED"?"SUCCEEDED":
     receipt.state==="FAILED"?"FAILED":"AWAITING_CONFIRMATION";
   await tx.deploymentExecution.update({where:{id:job.id},data:{
     state,receipt:receipt as unknown as Prisma.InputJsonValue,
     leaseToken:null,leaseUntil:null,dispatchedAt:current.dispatchedAt??new Date(),
     ...(state==="AWAITING_CONFIRMATION"?{nextAttemptAt:future(180000)}:{completedAt:new Date()}),
   }});
   await tx.auditEvent.create({data:{
     repositoryId:job.repositoryId,actorType:"CONTROLLER",actorId:job.environment,
     action:"deployment."+state.toLowerCase(),subjectId:job.id,
     metadata:{revisionId:job.revisionId,receiptId:receipt.receiptId},
   }});
 });
 return receipt;
}
export async function processNextDeployment():Promise<boolean> {
 const now=new Date();
 const next=await db.deploymentExecution.findFirst({where:{OR:[
   {state:{in:["QUEUED","WAITING_VALIDATION","RETRY","AWAITING_CONFIRMATION"]},nextAttemptAt:{lte:now}},
   {state:"DISPATCHING",leaseUntil:{lt:now}},
 ]},orderBy:[{nextAttemptAt:"asc"},{id:"asc"}]});
 if(!next)return false;
 const lease=randomUUID();
 const claim=await db.deploymentExecution.updateMany({where:{id:next.id,state:next.state,
   leaseToken:next.leaseToken},data:{
   state:"DISPATCHING",leaseToken:lease,leaseUntil:future(90000),attempts:{increment:1},
 }});
 if(!claim.count)return true;
 const job=await db.deploymentExecution.findUniqueOrThrow({where:{id:next.id}});
 const fail=async(error:unknown)=>{
   const message=(error instanceof Error?error.message:String(error)).slice(0,1000);
   const code=error instanceof SourceControlError?error.code:"DELIVERY_FAILED";
   const terminal=["DEPLOYMENT_STALE","NOT_INTEGRATED","SESSION_EXPIRED","CREDENTIAL_REVOKED",
     "ACCESS_DENIED","POLICY_DENIED","VALIDATION_STALE"].includes(code) || job.attempts>=job.maxAttempts;
   const blocked=code==="CHECKS_NOT_READY" || code==="VALIDATION_NOT_READY";
   await db.$transaction(async tx=>{
     const updated=await tx.deploymentExecution.updateMany({where:{id:job.id,leaseToken:lease,state:"DISPATCHING"},
       data:{state:terminal?"FAILED":blocked?"WAITING_VALIDATION":"RETRY",
       leaseToken:null,leaseUntil:null,
       nextAttemptAt:future(blocked?30000:Math.min(120000,1000*2**job.attempts)),
       lastError:message,...(terminal?{completedAt:new Date()}:{})}});
     if(updated.count)await tx.auditEvent.create({data:{
       repositoryId:job.repositoryId,actorType:"SYSTEM",actorId:"deployment-worker",
       action:"deployment."+ (terminal?"failed":blocked?"waiting_validation":"retry"),
       subjectId:job.id,metadata:{code,attempts:job.attempts},
     }});
   });
 };
 try{
   const actor=actorFor(job);
   await assertRepositoryPermission(actor,job.repositoryId,"admin");
   // No deployment is dispatched using historical readiness, revoked sessions or moved refs.
   const gate=await deploymentGate(job.repositoryId,job.integrationId,actor,false);
   if(gate.revision!==job.revisionId)throw new SourceControlError(409,"DEPLOYMENT_STALE","Revision changed");
   if(!gate.ready)throw new SourceControlError(409,"VALIDATION_NOT_READY","Pre-deployment checks pending");
   const controller=getController(job.repositoryId,job.environment);
   const command=JSON.stringify({apiVersion:1,deploymentId:job.id,repositoryId:job.repositoryId,
     integrationId:job.integrationId,revisionId:job.revisionId,environment:job.environment,
     idempotencyKey:job.id,requestedBy:job.actorId});
   const result=await sendDeployment(controller,command);
   if(result.httpStatus!==200 && result.httpStatus!==202)
     throw new SourceControlError(502,"CONTROLLER_REJECTED","Controller rejected deployment request");
   await receiveReceipt(job,result.body,result.receiptSignature);
 }catch(error){await fail(error);}
 return true;
}

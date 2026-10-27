import { performance } from "node:perf_hooks";
import { randomBytes, randomUUID } from "node:crypto";
import { db } from "../src/lib/prisma";
import { tokenHash } from "../src/lib/auth";
import { createCanonicalChangeset, stageCanonicalBlob } from "../src/source-control/canonical";
import { mutateReference } from "../src/source-control/refs";
import { enqueueIntegration } from "../src/integration/service";
import { SourceControlError } from "../src/source-control/contracts";

function percentile(values:number[], percent:number) {
 const sorted=[...values].sort((a,b)=>a-b);
 return Number((sorted[Math.min(sorted.length-1,Math.floor(sorted.length*percent))]??0).toFixed(2));
}
async function measured<T>(inputs:T[], concurrency:number, action:(item:T)=>Promise<void>) {
 let index=0;
 const latency:number[]=[];
 const start=performance.now();
 await Promise.all(Array.from({length:concurrency},async()=>{
  while(index<inputs.length){
   const item=inputs[index++];
   const before=performance.now();
   await action(item);
   latency.push(performance.now()-before);
  }
 }));
 const elapsed=(performance.now()-start)/1000;
 return {count:inputs.length,seconds:Number(elapsed.toFixed(2)),opsPerSecond:Math.round(inputs.length/elapsed),
  p50Ms:percentile(latency,.5),p95Ms:percentile(latency,.95),p99Ms:percentile(latency,.99)};
}
const uuid=randomBytes(6).toString("hex");
const actorId=await db.user.create({data:{handle:"bench-int-"+uuid,email:"bench-int-"+uuid+"@example.invalid"}});
const session=await db.humanSession.create({data:{userId:actorId.id,
  tokenHash:tokenHash(randomBytes(32).toString("hex")),expiresAt:new Date(Date.now()+3600000)}});
const actor={id:actorId.id,type:"HUMAN" as const,sessionId:session.id};
const repo=await db.repository.create({data:{ownerId:actorId.id,slug:"integration-benchmark-"+uuid,
 name:"Integration benchmark",defaultBranch:"main",requireHumanApproval:false,maxActivePullRequests:2000}});
const blob=await stageCanonicalBlob(repo.id,actor,Buffer.from("benchmark\n").toString("base64"));
const root=await createCanonicalChangeset(repo.id,actor,{apiVersion:2,parents:[],description:"root",
 operations:[{kind:"ADD",path:"base.txt",objectId:blob.id}]});
await mutateReference(repo.id,actor,{name:"branches/staging",operation:"CREATE",
 expectedGeneration:null,changesetId:root.id,mutationId:"initialize-"+uuid});
const changes:string[]=[];
const children=await measured(Array.from({length:40},(_,i)=>i),8,async i=>{
  const change=await createCanonicalChangeset(repo.id,actor,{apiVersion:2,parents:[root.id],
    description:"independent-"+i,operations:[{kind:"ADD",path:"changes/"+i+".txt",objectId:blob.id}]});
  changes.push(change.id);
});
const admissions=await measured(Array.from({length:400},(_,i)=>i),24,async i=>{
  await enqueueIntegration(repo.id,actor,{sourceChangesetId:changes[i%changes.length],
    targetRef:"branches/staging",requestKey:"load-"+uuid+"-"+i});
});
let won=0,conflicted=0;
const races=await measured(Array.from({length:120},(_,i)=>i),24,async i=>{
  try{
   await mutateReference(repo.id,actor,{name:"branches/staging",operation:"UPDATE",
     expectedGeneration:1,changesetId:changes[i%changes.length],mutationId:"writer-"+uuid+"-"+i});
   won++;
  }catch(error){
   if(error instanceof SourceControlError&&error.code==="REFERENCE_CONFLICT")conflicted++;
   else throw error;
  }
});
const current=await db.sourceReference.findUniqueOrThrow({where:{
 repositoryId_name:{repositoryId:repo.id,name:"branches/staging"},
}});
const result={workload:"PostgreSQL native integration admission and hot-reference CAS",
 repositoryId:repo.id,changesetPublication:children,integrationAdmission:admissions,
 refCas:races,winningUpdates:won,rejectedStaleWriters:conflicted,
 refGeneration:current.generation,expectedRefGeneration:2};
console.log(JSON.stringify(result,null,2));
if(won!==1||conflicted!==119||current.generation!==2||
 await db.changeIntegration.count({where:{repositoryId:repo.id}})!==400)process.exitCode=1;
await db.$disconnect();

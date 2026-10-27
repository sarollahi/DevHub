import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { db } from "../src/lib/prisma";
import { testSession } from "./support/identities";
import { stageCanonicalBlob, createCanonicalChangeset } from "../src/source-control/canonical";
import { mutateReference } from "../src/source-control/refs";
import { bootstrapProtectedBranch } from "../src/integration/bootstrap";
import { SourceControlError } from "../src/source-control/contracts";
import { snapshotFor } from "../src/validation/snapshot";
import { configurationDigest, recipes, fingerprint, signTask } from "../src/validation/policy";

test("protected bootstrap is fail-closed for direct creation, missing checks, invalid signatures and concurrent calls",
 {timeout:120000},async()=>{
 const suffix=randomBytes(6).toString("hex");
 const user=await db.user.create({data:{handle:"boot-"+suffix,email:"boot-"+suffix+"@example.invalid"}});
 const repo=await db.repository.create({data:{ownerId:user.id,slug:"boot-"+suffix,
   name:"Bootstrap test",defaultBranch:"main"}});
 const {actor}=await testSession(user.id);
 const blob=await stageCanonicalBlob(repo.id,actor,Buffer.from("safe").toString("base64"));
 const root=await createCanonicalChangeset(repo.id,actor,{apiVersion:2,parents:[],
   description:"bootstrap",operations:[{kind:"ADD",path:"README.txt",objectId:blob.id}]});
 const request={name:"main",changesetId:root.id,mutationId:"bootstrap-"+suffix};
 const fail=(code:string)=>(e:unknown)=>e instanceof SourceControlError&&e.code===code;
 await assert.rejects(()=>mutateReference(repo.id,actor,{name:"main",operation:"CREATE",
   changesetId:root.id,expectedGeneration:null,mutationId:"legacy-"+suffix}),fail("INTEGRATION_REQUIRED"));
 await assert.rejects(()=>bootstrapProtectedBranch(repo.id,actor,request),fail("REVIEW_REQUIRED"));
 await db.sourceReview.update({where:{changesetId:root.id},data:{state:"COMPLETED",riskTier:"LOW"}});
 await db.sourceChangeApproval.create({data:{changesetId:root.id,userId:user.id,decision:"APPROVED"}});
 const originals:Record<string,string|undefined>={};
 const img="registry.example.invalid/devhub/test@sha256:";
 for(const [key,hash] of [["VALIDATION_NODE_IMAGE","a"],["VALIDATION_SCAN_IMAGE","b"],
    ["VALIDATION_SECRETS_IMAGE","c"]]){
  originals[key]=process.env[key];process.env[key]=img+hash.repeat(64);
 }
 originals.VALIDATION_SIGNING_PUBLIC_KEY=process.env.VALIDATION_SIGNING_PUBLIC_KEY;
 const {privateKey,publicKey}=generateKeyPairSync("ed25519");
 process.env.VALIDATION_SIGNING_PUBLIC_KEY=Buffer.from(
   publicKey.export({type:"spki",format:"pem"})).toString("base64");
 try{
  await assert.rejects(()=>bootstrapProtectedBranch(repo.id,actor,request),fail("CHECKS_NOT_READY"));
  const policy=recipes();
  const snapshot=await snapshotFor(repo.id,root.id,null);
  const pipelineId=randomUUID();
  const tasks=policy.map(recipe=>{
   const row={id:randomUUID(),pipelineId,kind:recipe.kind,
    fingerprint:fingerprint(repo.id,root.id,null,snapshot.digest,snapshot.dependencyDigest,recipe),
    image:recipe.image,command:recipe.command,timeoutSeconds:recipe.timeoutSeconds,
    attempt:1,state:"PASSED" as const,exitCode:0,runnerId:"signed-fixture",logDigest:null,
    artifactDigest:null,reusedFromId:null};
   return {...row,signature:signTask(row,Buffer.from(
      privateKey.export({type:"pkcs8",format:"pem"})).toString("base64"))};
  });
  await db.validationPipeline.create({data:{
   id:pipelineId,repositoryId:repo.id,changesetId:root.id,targetChangesetId:null,
   idempotencyKey:"bootstrap-evidence-"+suffix,requestedBy:"HUMAN:"+user.id,
   snapshotDigest:snapshot.digest,dependencyDigest:snapshot.dependencyDigest,
   configurationDigest:configurationDigest(policy),state:"PASSED",tasks:{create:tasks.map(({pipelineId: _pipelineId,...task})=>task)},
  }});
  await db.validationTask.update({where:{id:tasks[0].id},data:{signature:"invalid"}});
  await assert.rejects(()=>bootstrapProtectedBranch(repo.id,actor,request),fail("CHECKS_NOT_READY"));
  await db.validationTask.update({where:{id:tasks[0].id},data:{signature:tasks[0].signature}});
  const [first,second]=await Promise.all([
   bootstrapProtectedBranch(repo.id,actor,request),
   bootstrapProtectedBranch(repo.id,actor,request),
  ]);
  assert.deepEqual([first.replayed,second.replayed].sort(),[false,true]);
  assert.equal(await db.sourceReference.count({where:{repositoryId:repo.id,name:"main"}}),1);
  assert.equal(await db.sourceRefMutation.count({where:{repositoryId:repo.id,name:"main"}}),1);
  assert.equal((await db.sourceReference.findUniqueOrThrow({where:{
   repositoryId_name:{repositoryId:repo.id,name:"main"}
  }})).changesetId,root.id);
 }finally{
  for(const [key,value] of Object.entries(originals)){
   if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
 }
});

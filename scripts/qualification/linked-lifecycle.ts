/**
 * Complete linked native lifecycle against isolated real DB/S3/runner/HTTP.
 * Never marks a stage PASSED on admission, fabricated test signatures or DB
 * row updates. Validation jobs execute real OCI containers and their signatures
 * must verify with the configured public signing key.
 *
 * This is a certification workload, NOT a facility to bypass release policy.
 */
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { db } from "../../src/lib/prisma";
import { tokenHash } from "../../src/lib/auth";
import { uploadBlob, verifiedBlobStream } from "../../src/object-store/service";
import { createCanonicalChangeset } from "../../src/source-control/canonical";
import { objectId } from "../../src/source-control/storage";
import { mutateReference } from "../../src/source-control/refs";
import { approveChangeset } from "../../src/source-control/service";
import { enqueueIntegration, processNextIntegration } from "../../src/integration/service";
import { indexBatch } from "../../src/workers/query-indexer";
import { processNextReview } from "../../src/review/source-review";
import { claimTask, executeTask } from "../../src/validation/runner";
import { verifyTask } from "../../src/validation/policy";

const flag=(name:string)=>process.argv.find(x=>x.startsWith("--"+name+"="))?.slice(name.length+3);
const output=flag("output");
const api=flag("api");
const timeoutSeconds=Number(flag("timeout-seconds")??"1800");
if (process.env.DEVHUB_QUALIFICATION_ISOLATED!=="YES" ||
    process.env.DEVHUB_QUALIFICATION_APPROVAL!=="RUN_FULL_SCALE" ||
    !output || !api || !/^https?:\/\//.test(api) ||
    !Number.isSafeInteger(timeoutSeconds) || timeoutSeconds<60 || timeoutSeconds>10800)
  throw Error("Isolated approval, --output, --api and valid --timeout-seconds required");
for(const key of ["VALIDATION_NODE_IMAGE","VALIDATION_SCAN_IMAGE","VALIDATION_SECRETS_IMAGE",
  "VALIDATION_SIGNING_PRIVATE_KEY","VALIDATION_SIGNING_PUBLIC_KEY",
  "OBJECT_STORE_ENDPOINT","OBJECT_STORE_BUCKET"]) {
  if(!process.env[key])throw Error("Required real execution/storage setting missing: "+key);
}
if (!/^https:\/\//.test(api) &&
    !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/.test(api))
  throw Error("Remote API must use HTTPS");
const started=performance.now();
const deadline=started+timeoutSeconds*1000;
const checkpoint:Array<{stage:string;elapsedMs:number;data:unknown}>=[];
const step=(stage:string,data:unknown)=>{checkpoint.push({stage,elapsedMs:Math.round(performance.now()-started),data});};
let repoId:string|null=null;
let stageError:string|null=null;
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const persist=async(status:string,other:Record<string,unknown>={})=>{
  await mkdir(dirname(output),{recursive:true});
  await writeFile(output,JSON.stringify({
    schemaVersion:1,kind:"linked-native-real-lifecycle",status,repositoryId:repoId,
    elapsedMs:Math.round(performance.now()-started),stages:checkpoint,
    error:stageError,...other,
  },null,2)+"\n",{mode:0o600});
};
const ensure=(value:unknown,message:string)=>{if(!value)throw Error(message);};
try {
  const suffix=randomBytes(6).toString("hex");
  const owner=await db.user.create({data:{handle:"link-"+suffix,email:"link-"+suffix+"@example.invalid"}});
  const session=await db.humanSession.create({data:{userId:owner.id,
    tokenHash:tokenHash(randomBytes(32).toString("hex")),
    expiresAt:new Date(Date.now()+3*3600_000)}});
  const human={type:"HUMAN" as const,id:owner.id,sessionId:session.id};
  const repo=await db.repository.create({data:{ownerId:owner.id,slug:"link-"+suffix,
    name:"Qualification linked "+suffix,defaultBranch:"main",requireHumanApproval:true}});
  repoId=repo.id;
  const scopes=["source:read","changeset:write","ref:update"];
  const agent=await db.agentIdentity.create({data:{ownerId:owner.id,name:"link-"+suffix,scopes}});
  const raw=randomBytes(32).toString("hex");
  const expiresAt=new Date(Date.now()+3*3600_000);
  const credential=await db.agentCredential.create({data:{agentId:agent.id,
    tokenHash:tokenHash(raw),label:"linked-qualification",scopes,expiresAt}});
  await db.agentDelegation.create({data:{agentId:agent.id,repositoryId:repoId,
    delegatedBy:owner.id,scopes,expiresAt}});
  const actor={type:"AGENT" as const,id:agent.id,credentialId:credential.id};
  const files=new Map<string,Buffer>([
    ["package.json",Buffer.from(JSON.stringify({
      name:"devhub-scale-fixture",private:true,version:"1.0.0",type:"module",
      scripts:{build:"node --check src/feature.js",
        test:"node --test test/feature.test.mjs",
        lint:"node --check src/feature.js"}
    },null,2)+"\n")],
    ["package-lock.json",Buffer.from(JSON.stringify({
      name:"devhub-scale-fixture",version:"1.0.0",lockfileVersion:3,
      requires:true,packages:{"":{name:"devhub-scale-fixture",version:"1.0.0"}}
    },null,2)+"\n")],
    ["src/feature.js",Buffer.from("export function feature() { return 'base'; }\n")],
    ["test/feature.test.mjs",Buffer.from(
      "import test from 'node:test';\n"+
      "import assert from 'node:assert/strict';\n"+
      "import {feature} from '../src/feature.js';\n"+
      "test('integrated source contains the exact approved feature',()=>{assert.equal(feature(),'verified-change');});\n")],
  ]);
  const bytesTransferred={uploaded:0,downloaded:0,objects:0};
  const hashes=new Map<string,string>();
  for(const [name,bytes] of files) {
    const stored=await uploadBlob(repoId,Readable.from([bytes]),objectId("BLOB",bytes));
    ensure(stored.id===objectId("BLOB",bytes),"S3 verified upload digest mismatch");
    hashes.set(name,stored.id);
    bytesTransferred.uploaded+=bytes.length;bytesTransferred.objects++;
    const record=await db.storedBlob.findUniqueOrThrow({where:{id:stored.id}});
    let downloaded=0;
    const parts:Buffer[]=[];
    for await(const part of await verifiedBlobStream(record)) {
      const buffer=Buffer.from(part);parts.push(buffer);downloaded+=buffer.length;
    }
    ensure(Buffer.concat(parts).equals(bytes),"Object-store readback mismatch");
    bytesTransferred.downloaded+=downloaded;
  }
  step("object-storage",bytesTransferred);
  const root=await createCanonicalChangeset(repoId,actor,{
    apiVersion:2,parents:[],description:"Qualify baseline source contents",
    operations:[...hashes].map(([path,id])=>({kind:"ADD" as const,path,objectId:id}))});
  const update=Buffer.from("export function feature() { return 'verified-change'; }\n");
  const nextBlob=await uploadBlob(repoId,Readable.from([update]),objectId("BLOB",update));
  hashes.set("src/feature.js",nextBlob.id);
  const change=await createCanonicalChangeset(repoId,actor,{
    apiVersion:2,parents:[root.id],description:"Qualify real immutable source change",
    operations:[{kind:"MODIFY",path:"src/feature.js",objectId:nextBlob.id}]});
  // Creating a branch in an approval-protected repository is itself a
  // privileged ref operation. Authorize the immutable root through the real
  // human approval service before the first reference transaction.
  await approveChangeset(repoId,root.id,human);
  step("baseline-human-approval",{rootId:root.id});
  const initial=await mutateReference(repoId,actor,{
    operation:"CREATE",name:"branches/qualification",changesetId:root.id,
    expectedGeneration:null,mutationId:"qual-init-"+suffix});
  step("publication",{root:root.id,source:change.id,referenceGeneration:initial.ref.generation,
    durableRoot:!!(await db.sourceSnapshotRoot.findUnique({where:{changesetId:change.id}}))});
  const integration=await enqueueIntegration(repoId,actor,{
    sourceChangesetId:change.id,targetRef:"branches/qualification",
    requestKey:"qual-link-"+suffix+"-integration"});
  step("integration-admitted",{integrationId:integration.id});
  let approved=new Set<string>();
  let signedExecutions=0,iterations=0,retried=0;
  while(performance.now()<deadline) {
    iterations++;
    await indexBatch(16);
    await processNextReview();
    await processNextIntegration();
    const current=await db.changeIntegration.findUniqueOrThrow({where:{id:integration.id}});
    if(["CONFLICTED","FAILED","SKIPPED"].includes(current.state))
      throw Error("Integration entered terminal non-success state: "+current.state+" "+(current.lastError??""));
    if(current.resultChangesetId){
      for(const id of [change.id,current.resultChangesetId]){
        if(approved.has(id))continue;
        const review=await db.sourceReview.findUnique({where:{changesetId:id}});
        if(review?.state!=="COMPLETED")continue;
        const validation=await db.sourceValidation.findUnique({where:{changesetId:id}});
        if(validation?.state!=="SUCCESS")continue;
        // This controlled human identity has valid approval rights; exact-revision
        // approval is performed by the production service, never raw SQL.
        await approveChangeset(repoId,id,human);
        approved.add(id);
      }
    }
    const task=await claimTask();
    if(task){
      // Real OCI execution; no manual status mutation or surrogate signature.
      await executeTask(task);
      const saved=await db.validationTask.findUniqueOrThrow({where:{id:task.id}});
      if(saved.state==="PASSED"){
        ensure(saved.exitCode===0 && verifyTask(saved),
          "Runner completed without authenticated signed evidence");
        signedExecutions++;
      }else if(saved.state==="QUEUED")retried++;
      else throw Error("Real OCI validation failed "+saved.kind+" state="+saved.state);
    }
    const updated=await db.changeIntegration.findUniqueOrThrow({where:{id:integration.id}});
    if(updated.state==="INTEGRATED")break;
    await pause(300);
  }
  const completed=await db.changeIntegration.findUniqueOrThrow({where:{id:integration.id}});
  ensure(completed.state==="INTEGRATED" && completed.resultChangesetId,
    "Timed out before signed validation, approval and integration completed");
  const resultId=completed.resultChangesetId!;
  const runs=await db.validationPipeline.findMany({where:{repositoryId:repoId},include:{tasks:true}});
  const stages=[{subject:change.id,target:null},{subject:resultId,target:root.id},{subject:resultId,target:null}];
  for(const stage of stages)ensure(runs.some(p=>p.changesetId===stage.subject &&
    p.targetChangesetId===stage.target && p.state==="PASSED" && p.tasks.length===6 &&
    p.tasks.every(task=>task.state==="PASSED" && task.exitCode===0 && verifyTask(task))),
  "Missing exact six-task signed validation evidence");
  step("signed-validation",{pipelines:runs.length,signedExecutions,retried,
    tasks:runs.flatMap(p=>p.tasks.map(task=>({
      id:task.id,kind:task.kind,state:task.state,
      durationMs:task.startedAt&&task.finishedAt?task.finishedAt.getTime()-task.startedAt.getTime():null,
      cpuNanos:task.measuredCpuNanos?.toString()??null})))});
  ensure(approved.has(change.id)&&approved.has(resultId),"Source and result approval not recorded");
  step("human-policy-approval",{approved:[...approved]});
  const ref=await db.sourceReference.findUniqueOrThrow({where:{
    repositoryId_name:{repositoryId:repoId,name:"branches/qualification"}}});
  ensure(ref.generation===2 && ref.changesetId===resultId,
    "Integration and atomic ref CAS did not commit together");
  const mutation=await db.sourceRefMutation.findFirst({where:{
    repositoryId:repoId,name:"branches/qualification",
    newChangesetId:resultId,newGeneration:2}});
  ensure(!!mutation,"Missing atomic reference mutation audit");
  step("integration-completed",{integrationId:integration.id,resultId,refGeneration:2,
    mutationId:mutation!.id});
  // Client observes the authoritative ref and content via authenticated
  // HTTP rather than reaching into the test driver's Prisma connection.
  const origin=api.replace(/\/$/,"");
  const httpJSON=async(path:string)=>{
    const response=await fetch(origin+path,{headers:{authorization:"Bearer "+raw},
      signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw Error("Client sync HTTP "+path+" returned "+response.status);
    return response.json() as Promise<any>;
  };
  const refs=await httpJSON("/api/v1/repositories/"+repoId+"/refs");
  const observed=refs.records.find((x:{name:string})=>x.name==="branches/qualification");
  ensure(observed?.generation===2 && observed?.changesetId===resultId,"Client observed stale ref");
  const tree=await httpJSON("/api/v2/repositories/"+repoId+"/changesets/"+resultId+"/tree?limit=100");
  ensure(tree.entries.length===files.size,"Client observed incomplete integrated tree");
  let clientBytes=0;
  for(const entry of tree.entries){
    const response=await fetch(origin+"/api/v2/repositories/"+repoId+
      "/objects/"+entry.objectId+"/content?path="+encodeURIComponent(entry.path)+
      "&revision="+resultId,{headers:{authorization:"Bearer "+raw},
        signal:AbortSignal.timeout(20000)});
    ensure(response.ok,"Client object hydration rejected: "+response.status);
    const content=Buffer.from(await response.arrayBuffer());
    ensure(objectId("BLOB",content)===entry.objectId,"Client object digest mismatch");
    clientBytes+=content.length;
  }
  step("verified-client-sync",{refsObserved:refs.records.length,
    revision:resultId,filesVerified:tree.entries.length,bytesVerified:clientBytes,
    objects:tree.entries.map((item:{path:string;objectId:string})=>({path:item.path,id:item.objectId}))});
  await persist("PASSED",{linked:{
    repositoryId:repoId,sourceId:change.id,integrationId:integration.id,
    resultId,referenceGeneration:ref.generation,
    pipelineCount:runs.length,verifiedClientFiles:tree.entries.length,
    realSignedTasks:signedExecutions,iterations}});
  console.log(JSON.stringify({kind:"linked-native-real-lifecycle",status:"PASSED",
    repositoryId:repoId,sourceId:change.id,resultId,pipelines:runs.length,
    signedExecutions,clientBytes,elapsedSeconds:(performance.now()-started)/1000}));
}catch(error){
  stageError=error instanceof Error?error.message:String(error);
  await persist("FAILED");
  console.error("Linked qualification failed, retained repository for forensic replay:",repoId,stageError);
  process.exitCode=1;
}finally{
  await db.$disconnect();
}

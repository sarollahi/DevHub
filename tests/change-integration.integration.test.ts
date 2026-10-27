import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { db } from "../src/lib/prisma";
import { createCanonicalChangeset, stageCanonicalBlob } from "../src/source-control/canonical";
import { mutateReference } from "../src/source-control/refs";
import { enqueueIntegration, executeIntegration } from "../src/integration/service";
import { testSession } from "./support/identities";
import { SourceControlError } from "../src/source-control/contracts";

test("native integration persists conflicts, rejects key reuse and preserves target under stale lease",
 { timeout: 120000 }, async () => {
  const suffix = randomBytes(6).toString("hex");
  const owner = await db.user.create({ data: {
    handle:"integration-"+suffix,email:"integration-"+suffix+"@example.invalid",
  } });
  const repository = await db.repository.create({ data: {
    ownerId:owner.id,slug:"integration-"+suffix,name:"Integration fixture",requireHumanApproval:false,
  } });
  const { actor } = await testSession(owner.id);
  const stage = async (content: string) => (await stageCanonicalBlob(repository.id,actor,
    Buffer.from(content).toString("base64"))).id;
  const a = await stage("base");
  const b = await stage("ours");
  const c = await stage("theirs");
  const root = await createCanonicalChangeset(repository.id,actor,{ apiVersion:2,
    parents:[],description:"root",operations:[{kind:"ADD",path:"f.txt",objectId:a}] });
  const left = await createCanonicalChangeset(repository.id,actor,{ apiVersion:2,
    parents:[root.id],description:"left",operations:[{kind:"MODIFY",path:"f.txt",objectId:b}] });
  const right = await createCanonicalChangeset(repository.id,actor,{ apiVersion:2,
    parents:[root.id],description:"right",operations:[{kind:"MODIFY",path:"f.txt",objectId:c}] });
  await mutateReference(repository.id,actor,{ name:"branches/integration",operation:"CREATE",
    expectedGeneration:null,changesetId:left.id,mutationId:"initialize-"+suffix });
  const body = {sourceChangesetId:right.id,targetRef:"branches/integration",requestKey:"merge-"+suffix};
  const job = await enqueueIntegration(repository.id,actor,body);
  assert.equal((await enqueueIntegration(repository.id,actor,body)).id,job.id);
  await assert.rejects(()=>enqueueIntegration(repository.id,actor,{...body,sourceChangesetId:root.id}),
    (error:unknown)=>error instanceof SourceControlError&&error.code==="IDEMPOTENCY_CONFLICT");
  const token = randomUUID();
  await db.changeIntegration.update({where:{id:job.id},data:{
    state:"PREPARING",leaseToken:token,leaseUntil:new Date(Date.now()+60000),
  }});
  await executeIntegration(job.id,randomUUID());
  assert.equal((await db.changeIntegration.findUniqueOrThrow({where:{id:job.id}})).state,"PREPARING");
  await executeIntegration(job.id,token);
  const result = await db.changeIntegration.findUniqueOrThrow({where:{id:job.id}});
  assert.equal(result.state,"CONFLICTED");
  assert.deepEqual(result.affectedPaths,["f.txt"]);
  assert.deepEqual((result.conflicts as Array<{path:string;code:string}>).map(x=>[x.path,x.code]),
    [["f.txt","EDIT_CONFLICT"]]);
  assert.equal(result.leaseToken,null);
  const ref = await db.sourceReference.findUniqueOrThrow({where:{
    repositoryId_name:{repositoryId:repository.id,name:"branches/integration"},
  }});
  assert.equal(ref.changesetId,left.id);
  assert.equal(ref.generation,1);
  const events = await db.auditEvent.findMany({where:{repositoryId:repository.id,subjectId:job.id},
    orderBy:{occurredAt:"asc"}});
  assert.deepEqual(events.map(x=>x.action),["integration.queued","integration.conflicted"]);
});


test("two independent integrations serialize final CAS, recompute after a ref race and safely revert", 
 {timeout:120000}, async () => {
  const suffix=randomBytes(6).toString("hex");
  const owner=await db.user.create({data:{
    handle:"raceintegration-"+suffix,email:"raceintegration-"+suffix+"@example.invalid",
  }});
  const repository=await db.repository.create({data:{
    ownerId:owner.id,slug:"raceintegration-"+suffix,name:"Integration CAS",requireHumanApproval:false,
  }});
  const {actor}=await testSession(owner.id);
  const id=repository.id, refName="branches/fast";
  const blob=async(text:string)=>(await stageCanonicalBlob(id,actor,Buffer.from(text).toString("base64"))).id;
  const rootId=(await blob("initial"));
  const a=await blob("first"); const b=await blob("second");
  const root=await createCanonicalChangeset(id,actor,{apiVersion:2,description:"start",parents:[],
    operations:[{kind:"ADD",path:"root.txt",objectId:rootId}]});
  const left=await createCanonicalChangeset(id,actor,{apiVersion:2,description:"A",parents:[root.id],
    operations:[{kind:"ADD",path:"left.txt",objectId:a}]});
  const right=await createCanonicalChangeset(id,actor,{apiVersion:2,description:"B",parents:[root.id],
    operations:[{kind:"ADD",path:"right.txt",objectId:b}]});
  await mutateReference(id,actor,{name:refName,operation:"CREATE",expectedGeneration:null,
    changesetId:root.id,mutationId:"init-"+suffix});
  // Only explicitly unprotected staging branches may opt out of execution checks.
  const {updateIntegrationPolicy}=await import("../src/integration/service");
  await updateIntegrationPolicy(id,refName,actor,{
    preChecks:false,targetChecks:false,postChecks:false,deploymentChecks:false,maxRetries:8,
  });
  const ja=await enqueueIntegration(id,actor,{sourceChangesetId:left.id,targetRef:refName,requestKey:"a-"+suffix+"-key"});
  const jb=await enqueueIntegration(id,actor,{sourceChangesetId:right.id,targetRef:refName,requestKey:"b-"+suffix+"-key"});
  const claim=async(jobId:string)=>{
    const token=randomUUID();
    await db.changeIntegration.update({where:{id:jobId},data:{
      state:"PREPARING",leaseToken:token,leaseUntil:new Date(Date.now()+180000),
    }});
    return token;
  };
  const approve=async(...ids:string[])=>{
    await db.sourceChangeApproval.createMany({data:ids.map(changesetId=>({
      changesetId,userId:owner.id,decision:"APPROVED" as const,
    })),skipDuplicates:true});
  };
  const [tokenA,tokenB]=await Promise.all([claim(ja.id),claim(jb.id)]);
  await Promise.all([executeIntegration(ja.id,tokenA),executeIntegration(jb.id,tokenB)]);
  const pA=await db.changeIntegration.findUniqueOrThrow({where:{id:ja.id}});
  const pB=await db.changeIntegration.findUniqueOrThrow({where:{id:jb.id}});
  assert.equal(pA.state,"WAITING_APPROVAL");
  assert.equal(pB.state,"WAITING_APPROVAL");
  assert.ok(pA.resultChangesetId&&pB.resultChangesetId);
  await approve(left.id,right.id,pA.resultChangesetId!,pB.resultChangesetId!);
  const [resultA,resultB]=await Promise.allSettled([
    executeIntegration(ja.id,await claim(ja.id)),
    executeIntegration(jb.id,await claim(jb.id)),
  ]);
  assert.equal([resultA,resultB].filter(x=>x.status==="fulfilled").length,1);
  assert.equal([resultA,resultB].filter(x=>x.status==="rejected").length,1);
  const first=await db.sourceReference.findUniqueOrThrow({where:{
    repositoryId_name:{repositoryId:id,name:refName},
  }});
  assert.equal(first.generation,2);
  const loserId=resultA.status==="rejected"?ja.id:jb.id;
  const winnerId=resultA.status==="fulfilled"?ja.id:jb.id;
  // Simulate worker lease expiry and restart: no old validation/approval is reused on the next head.
  await db.changeIntegration.update({where:{id:loserId},data:{
    state:"RETRY",leaseToken:null,leaseUntil:null,attempts:1,
  }});
  await executeIntegration(loserId,await claim(loserId));
  const rebased=await db.changeIntegration.findUniqueOrThrow({where:{id:loserId}});
  assert.equal(rebased.state,"WAITING_APPROVAL");
  assert.notEqual(rebased.resultChangesetId, (loserId===ja.id?pA:pB).resultChangesetId);
  await approve(rebased.resultChangesetId!);
  await executeIntegration(loserId,await claim(loserId));
  const advanced=await db.sourceReference.findUniqueOrThrow({where:{
    repositoryId_name:{repositoryId:id,name:refName},
  }});
  assert.equal(advanced.generation,3);
  const {readCanonicalSnapshotForValidation}=await import("../src/source-control/canonical");
  const merged=await readCanonicalSnapshotForValidation(id,advanced.changesetId);
  assert.deepEqual(merged.entries.map(e=>e.path).sort(),["left.txt","right.txt","root.txt"]);
  const completed=await db.changeIntegration.findUniqueOrThrow({where:{id:loserId}});
  assert.equal(completed.state,"INTEGRATED");
  // Revert the second integration by applying its inverse as another audited changeset.
  const revert=await enqueueIntegration(id,actor,{sourceChangesetId:completed.resultChangesetId!,
    targetRef:refName,requestKey:"revert-"+suffix+"-key",mode:"REVERT",revertIntegrationId:loserId});
  await executeIntegration(revert.id,await claim(revert.id));
  const revertDraft=await db.changeIntegration.findUniqueOrThrow({where:{id:revert.id}});
  assert.equal(revertDraft.state,"WAITING_APPROVAL");
  await approve(revertDraft.resultChangesetId!);
  await executeIntegration(revert.id,await claim(revert.id));
  const afterRevert=await db.sourceReference.findUniqueOrThrow({where:{
    repositoryId_name:{repositoryId:id,name:refName},
  }});
  assert.equal(afterRevert.generation,4);
  const snap=await readCanonicalSnapshotForValidation(id,afterRevert.changesetId);
  assert.equal(snap.entries.length,2);
  const winner=await db.changeIntegration.findUniqueOrThrow({where:{id:winnerId}});
  assert.ok(snap.entries.some(e=>e.path==="root.txt"));
  assert.ok(snap.entries.some(e=>e.path===(winner.sourceChangesetId===left.id?"left.txt":"right.txt")));
  assert.equal(await db.sourceRefMutation.count({where:{repositoryId:id,name:refName}}),4);
});

import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { db } from "../src/lib/prisma";
import { testSession } from "./support/identities";
import { createCanonicalChangeset } from "../src/source-control/canonical";
import { SourceControlError } from "../src/source-control/contracts";
import { objectId } from "../src/source-control/storage";
import { submitValidation, cancelPipeline, hasVerifiedChecks, pipelineDetail } from "../src/validation/service";
import { claimTask, executeTask } from "../src/validation/runner";
import { digest, fingerprint, recipes, verifyTask } from "../src/validation/policy";

test("PostgreSQL validation provenance, idempotency, lease, isolation and retries", {timeout:90000}, async t=>{
  const suffix=randomBytes(6).toString("hex");
  const user=await db.user.create({data:{handle:"valid-"+suffix,email:suffix+"@example.invalid"}});
  const repo=await db.repository.create({data:{ownerId:user.id,slug:"validation",name:"validation"}});
  const other=await db.repository.create({data:{ownerId:user.id,slug:"other",name:"other"}});
  const { actor } = await testSession(user.id);
  const original={
    VALIDATION_NODE_IMAGE:process.env.VALIDATION_NODE_IMAGE,
    VALIDATION_SCAN_IMAGE:process.env.VALIDATION_SCAN_IMAGE,
    VALIDATION_SECRETS_IMAGE:process.env.VALIDATION_SECRETS_IMAGE,
    VALIDATION_SIGNING_PRIVATE_KEY:process.env.VALIDATION_SIGNING_PRIVATE_KEY,
    VALIDATION_SIGNING_PUBLIC_KEY:process.env.VALIDATION_SIGNING_PUBLIC_KEY,
    VALIDATION_TENANT_MAX_PENDING:process.env.VALIDATION_TENANT_MAX_PENDING,
  };
  const image=process.env.VALIDATION_FIXTURE_IMAGE||"example.invalid/node@sha256:"+"a".repeat(64);
  process.env.VALIDATION_NODE_IMAGE=image;
  process.env.VALIDATION_SCAN_IMAGE=image;
  process.env.VALIDATION_SECRETS_IMAGE=image;
  const keys=generateKeyPairSync("ed25519");
  process.env.VALIDATION_SIGNING_PRIVATE_KEY=Buffer.from(keys.privateKey.export({type:"pkcs8",format:"pem"})).toString("base64");
  process.env.VALIDATION_SIGNING_PUBLIC_KEY=Buffer.from(keys.publicKey.export({type:"spki",format:"pem"})).toString("base64");
  t.after(async()=>{
    // Published changesets and audit events are deliberately append-only.
    // CI uses an isolated database; retain their immutable fixtures.
    await db.validationPipeline.deleteMany({where:{repositoryId:{in:[repo.id,other.id]}}});
    for(const [name,value] of Object.entries(original)){
      if(value===undefined)delete process.env[name];else process.env[name]=value;
    }
    await db.$disconnect();
  });
  const blob=Buffer.from(JSON.stringify({name:"fixture-"+suffix,scripts:{test:"echo pass"}}));
  const id=objectId("BLOB",blob);
  await db.sourceObject.create({data:{id,kind:"BLOB",data:blob,byteSize:blob.length}});
  await db.sourceObjectGrant.create({data:{repositoryId:repo.id,objectId:id}});
  const change=await createCanonicalChangeset(repo.id,actor,{
    apiVersion:2,parents:[],description:"validation input",operations:[
      {kind:"ADD",path:"package.json",objectId:id,mode:"100644"}
    ]});
  let pipelineId="";
  await t.test("durable submission has six jobs and source-specific admission",async()=>{
    const result=await submitValidation(repo.id,change.id,null,"validation-once-"+suffix,actor);
    pipelineId=result.pipeline.id;
    assert.equal(result.created,true);
    const again=await submitValidation(repo.id,change.id,null,"validation-once-"+suffix,actor);
    assert.equal(again.created,false);
    assert.equal(again.pipeline.id,pipelineId);
    assert.equal(await db.validationTask.count({where:{pipelineId}}),6);
    await assert.rejects(()=>submitValidation(other.id,change.id,null,"other-run-"+suffix,actor),
      (e:unknown)=>e instanceof SourceControlError&&e.code==="NOT_FOUND");
    await assert.rejects(()=>submitValidation(repo.id,change.id,change.id,"bad-target-"+suffix,actor),
      (e:unknown)=>e instanceof SourceControlError&&e.code==="NOT_FOUND");
    process.env.VALIDATION_TENANT_MAX_PENDING="6";
    await assert.rejects(()=>submitValidation(repo.id,change.id,null,"overquota-"+suffix,actor),
      (e:unknown)=>e instanceof SourceControlError&&e.code==="TENANT_QUEUE_QUOTA");
    delete process.env.VALIDATION_TENANT_MAX_PENDING;
    assert.equal(await hasVerifiedChecks(repo.id,change.id,null),false);
  });
  if(process.env.RUN_VALIDATION_CONTAINER_TEST==="1"){
    await t.test("real OCI execution rejects writes and network, stores logs/artifact and signs evidence",async()=>{
      const task=await db.validationTask.findFirstOrThrow({where:{pipelineId,kind:"COMPILE"}});
      // This fixture tests runner isolation, not a compilation pass. Its modified recipe cannot
      // satisfy production compilation provenance.
      const command="echo running; if touch /source/forbidden 2>/dev/null; then exit 21; fi; "+
        "if touch /etc/forbidden 2>/dev/null; then exit 22; fi; "+
        "if wget -T 1 -q http://1.1.1.1 -O /tmp/response 2>/dev/null; then exit 23; fi; "+
        "echo pass >/artifacts/isolated.txt; echo isolated";
      const r={kind:"COMPILE" as const,image,command,timeoutSeconds:20};
      const p=await db.validationPipeline.findUniqueOrThrow({where:{id:pipelineId}});
      await db.validationTask.update({where:{id:task.id},data:{command,image,
        timeoutSeconds:r.timeoutSeconds,fingerprint:fingerprint(repo.id,change.id,null,p.snapshotDigest,p.dependencyDigest,r)}});
      await db.validationTask.updateMany({where:{pipelineId,NOT:{id:task.id}},data:{state:"CANCELLED"}});
      const claimed=await claimTask();
      assert.equal(claimed?.id,task.id);
      await executeTask(claimed!);
      const completed=await db.validationTask.findUniqueOrThrow({where:{id:task.id},
        include:{logs:true,artifacts:true}});
      assert.equal(completed.state,"PASSED",completed.summary||"");
      assert.ok(verifyTask(completed));
      assert.ok(completed.logs.some(x=>x.content.includes("isolated")));
      assert.equal(completed.artifacts[0]?.name,"isolated.txt");
      assert.equal(Buffer.from(completed.artifacts[0].content).toString().trim(),"pass");
      assert.equal(await hasVerifiedChecks(repo.id,change.id,null),false);
    });
    await t.test("failing build records signed nonzero exit and does not poison other jobs",async()=>{
      const run=await submitValidation(repo.id,change.id,null,"run-failure-"+suffix,actor);
      const task=await db.validationTask.findFirstOrThrow({where:{pipelineId:run.pipeline.id,kind:"COMPILE"}});
      await db.validationTask.updateMany({where:{pipelineId:run.pipeline.id,NOT:{id:task.id}},data:{state:"CANCELLED"}});
      const claimed=await claimTask();
      assert.equal(claimed?.id,task.id);
      // A shell-only fixture returns nonzero because the real pinned test image has no npm.
      await executeTask(claimed!);
      const result=await db.validationTask.findUniqueOrThrow({where:{id:task.id}});
      assert.equal(result.state,"FAILED");
      assert.ok(result.exitCode!==0);
      assert.ok(verifyTask(result));
    });
  }
  await t.test("cancelling queued jobs forbids later successful claims",async()=>{
    await cancelPipeline(repo.id,pipelineId);
    const current=await pipelineDetail(repo.id,pipelineId);
    assert.equal(current?.state,"CANCELLED");
    assert.equal(current?.tasks.some(c=>c.state==="QUEUED"),false);
  });
  await t.test("expired leases are reclaimed and superseded workers cannot publish",async()=>{
    const run=await submitValidation(repo.id,change.id,null,"worker-recovery-"+suffix,actor);
    const target=await db.validationTask.findFirstOrThrow({where:{pipelineId:run.pipeline.id,kind:"COMPILE"}});
    await db.validationTask.updateMany({where:{pipelineId:run.pipeline.id,NOT:{id:target.id}},data:{state:"CANCELLED"}});
    const originalLease=await claimTask();
    assert.equal(originalLease?.id,target.id);
    await db.validationTask.update({where:{id:target.id},data:{leaseUntil:new Date(0)}});
    const recovered=await claimTask();
    assert.equal(recovered?.id,target.id);
    assert.equal(recovered?.attempt,2);
    assert.notEqual(recovered?.leaseToken,originalLease?.leaseToken);
    const stale=await db.validationTask.updateMany({where:{id:target.id,leaseToken:originalLease!.leaseToken},
      data:{state:"PASSED"}});
    assert.equal(stale.count,0);
    await cancelPipeline(repo.id,run.pipeline.id);
    assert.equal((await db.validationTask.findUniqueOrThrow({where:{id:target.id}})).state,"CANCELLED");
  });
  if(process.env.RUN_VALIDATION_CONTAINER_TEST==="1"){
    await t.test("timeout forcibly terminates an isolated container and signs the failure",async()=>{
      const run=await submitValidation(repo.id,change.id,null,"timeout-"+suffix,actor);
      const task=await db.validationTask.findFirstOrThrow({where:{pipelineId:run.pipeline.id,kind:"COMPILE"}});
      await db.validationTask.updateMany({where:{pipelineId:run.pipeline.id,NOT:{id:task.id}},data:{state:"CANCELLED"}});
      const p=await db.validationPipeline.findUniqueOrThrow({where:{id:run.pipeline.id}});
      const r={kind:"COMPILE" as const,image,command:"sleep 7",timeoutSeconds:1};
      await db.validationTask.update({where:{id:task.id},data:{image,command:r.command,
        timeoutSeconds:1,fingerprint:fingerprint(repo.id,change.id,null,p.snapshotDigest,p.dependencyDigest,r)}});
      const claimed=await claimTask();
      assert.equal(claimed?.id,task.id);
      await executeTask(claimed!);
      const done=await db.validationTask.findUniqueOrThrow({where:{id:task.id}});
      assert.equal(done.state,"TIMED_OUT",done.summary||"");
      assert.ok(verifyTask(done));
    });
    await t.test("oversized output is rejected and infrastructure failure remains retryable",async()=>{
      const run=await submitValidation(repo.id,change.id,null,"artifact-quota-"+suffix,actor);
      const task=await db.validationTask.findFirstOrThrow({where:{pipelineId:run.pipeline.id,kind:"COMPILE"}});
      await db.validationTask.updateMany({where:{pipelineId:run.pipeline.id,NOT:{id:task.id}},data:{state:"CANCELLED"}});
      const p=await db.validationPipeline.findUniqueOrThrow({where:{id:run.pipeline.id}});
      const r={kind:"COMPILE" as const,image,command:
        "dd if=/dev/zero of=/artifacts/excess.bin bs=1024 count=3072 >/dev/null 2>&1",
        timeoutSeconds:20};
      await db.validationTask.update({where:{id:task.id},data:{image,command:r.command,
        timeoutSeconds:20,fingerprint:fingerprint(repo.id,change.id,null,p.snapshotDigest,p.dependencyDigest,r)}});
      const claimed=await claimTask();
      assert.equal(claimed?.id,task.id);
      await executeTask(claimed!);
      const after=await db.validationTask.findUniqueOrThrow({where:{id:task.id}});
      assert.equal(after.state,"QUEUED");
      assert.equal(after.attempt,1);
      assert.match(after.summary||"",/Artifact policy limit/);
      assert.equal(after.signature,null);
      await cancelPipeline(repo.id,run.pipeline.id);
    });
  }
});

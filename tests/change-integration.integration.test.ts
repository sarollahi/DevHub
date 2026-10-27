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

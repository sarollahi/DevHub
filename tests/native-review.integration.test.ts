import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { db } from "../src/lib/prisma";
import { createCanonicalChangeset, stageCanonicalBlob } from "../src/source-control/canonical";
import { processReview } from "../src/review/source-review";
import { POST as decide } from "../src/app/api/v2/repositories/[id]/changesets/[changesetId]/review/route";

test("authoritative review pipeline: duplicates, overlaps, policies and revision-bound decisions", { timeout: 100000 }, async () => {
  const suffix = randomBytes(8).toString("hex");
  const owner = await db.user.create({ data: { handle: "review-" + suffix, email: "review-" + suffix + "@example.invalid" } });
  const repo = await db.repository.create({ data: { ownerId: owner.id, name: "Review integration", slug: "review" } });
  const actor = { type: "HUMAN" as const, id: owner.id };
  const stage = async (contents: string) => (await stageCanonicalBlob(repo.id, Buffer.from(contents).toString("base64"))).id;
  const original = await stage("first\nsecond\nthird\n");
  const first = await stage("FIRST\nsecond\nthird\n");
  const second = await stage("first\nSECOND\nthird\n");
  const conflict = await stage("DIFFERENT\nsecond\nthird\n");
  const secret = await stage('const api_key = "' + randomBytes(18).toString('hex') + '";\n');
  const harmless = await stage("A harmless release note.\n");
  const publish = (description: string, parents: string[], operations: unknown[]) =>
    createCanonicalChangeset(repo.id, actor, { apiVersion: 2, description, parents, operations });
  const root = await publish("root", [], [{kind:"ADD",path:"src/example.ts",objectId:original}]);
  const left = await publish("left", [root.id], [{kind:"MODIFY",path:"src/example.ts",objectId:first}]);
  const dup = await publish("different description, same exact data", [root.id], [{kind:"MODIFY",path:"src/example.ts",objectId:first}]);
  const other = await publish("different region", [root.id], [{kind:"MODIFY",path:"src/example.ts",objectId:second}]);
  const overlapping = await publish("same region conflict", [root.id], [{kind:"MODIFY",path:"src/example.ts",objectId:conflict}]);
  const credentials = await publish("appears harmless", [root.id], [{kind:"ADD",path:"docs/temporary.txt",objectId:secret}]);
  const document = await publish("independent docs", [root.id], [{kind:"ADD",path:"docs/release.md",objectId:harmless}]);

  async function analyze(id: string) {
    const lease = new Date(Date.now() + 120_000);
    const claimed = await db.sourceReview.updateMany({where:{changesetId:id,state:"QUEUED"},
      data:{state:"RUNNING",attempts:1,leaseUntil:lease}});
    assert.equal(claimed.count,1);
    return processReview(id,lease,1);
  }
  await analyze(root.id);
  await analyze(left.id);
  await analyze(dup.id);
  await analyze(other.id);
  await analyze(overlapping.id);
  await analyze(credentials.id);
  await analyze(document.id);
  const dupReview = await db.sourceReview.findUniqueOrThrow({ where: { changesetId: dup.id } });
  assert.equal(dupReview.exactDuplicateOf, left.id);
  assert.ok(Array.isArray(dupReview.related));
  const independent = await db.sourceReview.findUniqueOrThrow({ where: { changesetId: other.id } });
  const overlap = await db.sourceReview.findUniqueOrThrow({ where: { changesetId: overlapping.id } });
  const related = independent.related as Array<{changesetId:string;kind:string}>;
  const overlapRelated = overlap.related as Array<{changesetId:string;kind:string}>;
  assert.ok(related.some(x=>x.changesetId===left.id&&x.kind==="FILE"),"independent regions are only file overlap");
  assert.ok(overlapRelated.some(x=>x.changesetId===left.id&&x.kind==="REGION"),"conflicting regions are prioritized");
  assert.equal((await db.sourceReview.findUniqueOrThrow({where:{changesetId:credentials.id}})).riskTier,"CRITICAL");
  assert.equal((await db.sourceReview.findUniqueOrThrow({where:{changesetId:document.id}})).riskTier,"LOW");
  const endpoint = (id: string) => "http://localhost:3000/api/v2/repositories/"+repo.id+"/changesets/"+id+"/review";
  const send = (id: string, expected: string) => decide(new NextRequest(endpoint(id), {
    method:"POST",headers:{ authorization:"Bearer "+process.env.ADMIN_TOKEN,"content-type":"application/json" },
    body:JSON.stringify({expectedChangesetId:expected,decision:"APPROVED"}),
  }), {params:Promise.resolve({id:repo.id,changesetId:id})});
  assert.equal((await send(left.id,left.id)).status,200);
  assert.equal((await send(overlapping.id,left.id)).status,409,"mismatched revision must fail");
  assert.equal(await db.sourceChangeApproval.count({where:{changesetId:overlapping.id}}),0,
    "approval must not carry across changeset revisions");
  assert.equal(await db.auditEvent.count({where:{repositoryId:repo.id,action:"changeset.review.approved"}}),1);
});

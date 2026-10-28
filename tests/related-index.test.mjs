import test from "node:test";
import assert from "node:assert/strict";
import { assessNativeChangeset } from "../src/review/analysis.ts";
import { issueKeys, subsystem, indexSignals, vectorBuckets, equivalenceFingerprint,
  contentFingerprint, classifyCandidate, deterministicPriority } from "../src/review/index-algorithms.ts";
const A="a".repeat(64),B="b".repeat(64),C="c".repeat(64);
function fixture(path="src/auth/user.ts",parents=[C],description="SEC-123"){
  const before=new Map([[path,{objectId:A,mode:"100644"}]]);
  const after=new Map([[path,{objectId:B,mode:"100644"}]]);
  const operations=[{kind:"MODIFY",path,objectId:B}];
  const assessment=assessNativeChangeset({parents,description,operations,before,after,
    bytes:new Map([[A,Buffer.from("one\ntwo\nthree")],[B,Buffer.from("ONE\ntwo\nthree")]])});
  const equivalenceHash=equivalenceFingerprint(operations,before,after);
  return {assessment,equivalenceHash,signals:indexSignals({assessment,description,equivalenceHash,
    contentHash:contentFingerprint(operations,after)})};
}
test("repository-wide keys normalize issues and subsystems",()=>{
  assert.deepEqual(issueKeys("SEC-123 SEC-123 #92"),["SEC-123","#92"]);
  assert.equal(subsystem("src/auth/user.ts"),"src/auth");
  assert.ok(fixture().signals.some(x=>x.kind==="ISSUE"));
});
test("parent-independent equivalence is distinct from exact identity",()=>{
  const one=fixture(),two=fixture("src/auth/user.ts",["d".repeat(64)]);
  assert.notEqual(one.assessment.fingerprint,two.assessment.fingerprint);
  assert.equal(one.equivalenceHash,two.equivalenceHash);
  const matched=classifyCandidate(one.assessment,one.equivalenceHash,{changesetId:C,
    fingerprint:two.assessment.fingerprint,equivalenceHash:two.equivalenceHash,
    regions:two.assessment.regions,embedding:[],signals:new Set(["EQUIVALENT"])});
  assert.equal(matched?.kind,"EQUIVALENT");
  const exact=classifyCandidate(one.assessment,one.equivalenceHash,{changesetId:C,
    fingerprint:one.assessment.fingerprint,equivalenceHash:null,
    regions:[],embedding:[],signals:new Set(["EXACT"])});
  assert.equal(exact?.kind,"DUPLICATE");
});
test("disjoint same-file intervals are not conflicts",()=>{
  const source=fixture(),region=source.assessment.regions[0];
  const hit=region=>classifyCandidate(source.assessment,source.equivalenceHash,{
    changesetId:C,fingerprint:null,equivalenceHash:null,
    regions:[region],embedding:[],signals:new Set(["PATH"])});
  assert.equal(hit({...region,start:region.end+20,end:region.end+25})?.kind,"FILE");
  assert.equal(hit(region)?.kind,"REGION");
});
test("ANN buckets are versioned, isolated and multiprobe-indexed",()=>{
  const vector=Array.from({length:128},(_,i)=>Math.sin(i));
  const base=vectorBuckets(vector,"p:m");
  const probes=vectorBuckets(vector,"p:m",true);
  assert.equal(base.length,4);assert.equal(probes.length,52);
  assert.ok(base.every(x=>probes.includes(x)));
  assert.notDeepEqual(base,vectorBuckets(vector,"other:m"));
  assert.deepEqual(vectorBuckets([NaN],"p:m"),[]);
});
test("advisory similarity never determines deterministic review priority",()=>{
  const high=deterministicPriority(90,[],"COMPLETED",false);
  const low=deterministicPriority(5,[{changesetId:C,kind:"SIMILAR",score:1}],"COMPLETED",false);
  assert.ok(high>low);
  assert.ok(deterministicPriority(90,[],"FAILED",false)>high);
  assert.ok(deterministicPriority(90,[],"COMPLETED",true)<low);
});

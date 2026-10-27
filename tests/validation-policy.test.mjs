import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { configurationDigest, fingerprint, recipes, signTask, verifyTask } from "../src/validation/policy.ts";
const image="registry.invalid/devhub/node@sha256:"+"a".repeat(64);
const environment={
  VALIDATION_NODE_IMAGE:image,
  VALIDATION_SCAN_IMAGE:"registry.invalid/devhub/scanner@sha256:"+"b".repeat(64),
  VALIDATION_SECRETS_IMAGE:"registry.invalid/devhub/secrets@sha256:"+"c".repeat(64),
};
const {privateKey,publicKey}=generateKeyPairSync("ed25519");
const signing=Buffer.from(privateKey.export({type:"pkcs8",format:"pem"})).toString("base64");
const verifying=Buffer.from(publicKey.export({type:"spki",format:"pem"})).toString("base64");

test("six reproducible, immutable and offline execution policies",()=>{
  const policy=recipes(environment);
  assert.deepEqual(policy.map(p=>p.kind).sort(),
    ["COMPILE","DEPENDENCIES","LINT","SECRETS","SECURITY","TEST"].sort());
  assert.ok(policy.every(p=>p.image.includes("@sha256:") && p.timeoutSeconds>=1));
  assert.ok(policy.every(p=>!/\b(curl|wget)\b/.test(p.command)));
  assert.equal(configurationDigest(policy),configurationDigest(recipes(environment)));
  assert.throws(()=>recipes({...environment,VALIDATION_NODE_IMAGE:"node:22"}),/digest/);
  assert.throws(()=>recipes({...environment,VALIDATION_SCAN_IMAGE:undefined}),/digest/);
});
test("reuse key changes for every authorization/provenance dimension",()=>{
  const r=recipes(environment)[0];
  const id="a".repeat(64), target="b".repeat(64), snap="c".repeat(64), deps="d".repeat(64);
  const base=fingerprint("tenant1",id,null,snap,deps,r);
  for(const candidate of [
    fingerprint("tenant2",id,null,snap,deps,r),
    fingerprint("tenant1","e".repeat(64),null,snap,deps,r),
    fingerprint("tenant1",id,target,snap,deps,r),
    fingerprint("tenant1",id,null,"e".repeat(64),deps,r),
    fingerprint("tenant1",id,null,snap,"e".repeat(64),r),
    fingerprint("tenant1",id,null,snap,deps,{...r,command:r.command+"; true"}),
    fingerprint("tenant1",id,null,snap,deps,{...r,image:environment.VALIDATION_SCAN_IMAGE}),
    fingerprint("tenant1",id,null,snap,deps,{...r,timeoutSeconds:r.timeoutSeconds+1}),
  ])assert.notEqual(base,candidate);
});
test("Ed25519 evidence cannot be forged or moved to a different check",()=>{
  const task={
    id:"check-1",pipelineId:"pipeline-1",kind:"TEST",fingerprint:"a".repeat(64),
    image,command:"npm test",timeoutSeconds:100,attempt:1,state:"PASSED",
    exitCode:0,runnerId:"runner-1",logDigest:"b".repeat(64),
    artifactDigest:"c".repeat(64),reusedFromId:null,
  };
  const signature=signTask(task,signing);
  assert.ok(verifyTask({...task,signature},verifying));
  assert.ok(!verifyTask({...task,signature,fingerprint:"d".repeat(64)},verifying));
  assert.ok(!verifyTask({...task,signature,state:"FAILED"},verifying));
  assert.ok(!verifyTask({...task,signature,pipelineId:"pipeline-2"},verifying));
  assert.ok(!verifyTask({...task,signature,logDigest:"e".repeat(64)},verifying));
  assert.ok(!verifyTask({...task,signature:null},verifying));
});

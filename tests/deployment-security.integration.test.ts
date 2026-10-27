import test from "node:test";
import assert from "node:assert/strict";
import { assertPublicAddress, authenticSignature, signature, validateReceipt, getController } from "../src/deployment/transport";

test("deployment controller must be pinned to one authorized HTTPS environment and repository",()=>{
 const id="11111111-1111-4111-8111-111111111111";
 const backup=process.env.DEPLOYMENT_CONTROLLERS_JSON;
 const key=process.env.DEPLOYMENT_PROD_KEY;
 try{
  process.env.DEPLOYMENT_CONTROLLERS_JSON=JSON.stringify({
   production:{url:"https://deployment.example.com/execute",secretEnv:"DEPLOYMENT_PROD_KEY",repositories:[id]},
  });
  process.env.DEPLOYMENT_PROD_KEY="x".repeat(48);
  assert.equal(getController(id,"production").url.hostname,"deployment.example.com");
  assert.throws(()=>getController("22222222-2222-4222-8222-222222222222","production"));
  process.env.DEPLOYMENT_CONTROLLERS_JSON=JSON.stringify({
   production:{url:"https://127.0.0.1/execute",secretEnv:"DEPLOYMENT_PROD_KEY",repositories:[id]},
  });
  assert.throws(()=>getController(id,"production"));
  process.env.DEPLOYMENT_CONTROLLERS_JSON=JSON.stringify({
   production:{url:"http://deployment.example.com/execute",secretEnv:"DEPLOYMENT_PROD_KEY",repositories:[id]},
  });
  assert.throws(()=>getController(id,"production"));
  process.env.DEPLOYMENT_CONTROLLERS_JSON=JSON.stringify({
   production:{url:"https://user:secret@deployment.example.com/execute",secretEnv:"DEPLOYMENT_PROD_KEY",repositories:[id]},
  });
  assert.throws(()=>getController(id,"production"));
 }finally{
  if(backup===undefined)delete process.env.DEPLOYMENT_CONTROLLERS_JSON;else process.env.DEPLOYMENT_CONTROLLERS_JSON=backup;
  if(key===undefined)delete process.env.DEPLOYMENT_PROD_KEY;else process.env.DEPLOYMENT_PROD_KEY=key;
 }
});
test("refuse private and metadata-service addresses",()=>{
 for(const ip of ["127.0.0.1","10.1.1.1","172.16.0.1","192.168.1.1",
  "169.254.169.254","100.100.100.200","::1","fd00::1","::ffff:127.0.0.1"]) {
  assert.throws(()=>assertPublicAddress(ip),ip);
 }
 for(const ip of ["8.8.8.8","1.1.1.1","2606:4700:4700::1111"]) assert.doesNotThrow(()=>assertPublicAddress(ip));
});
test("controller HMAC response cannot authorize altered revisions, environment or state",()=>{
 const key="z".repeat(48);
 const expected={id:"d",revisionId:"a".repeat(64),environment:"production"};
 const receipt={deploymentId:"d",revisionId:expected.revisionId,environment:"production",
  state:"SUCCEEDED",receiptId:"receipt-0001"};
 const content=JSON.stringify(receipt);
 const sig=signature(key,content);
 assert.ok(authenticSignature(key,content,sig));
 assert.ok(!authenticSignature(key,content.replace("SUCCEEDED","FAILED"),sig));
 assert.ok(!authenticSignature("other",content,sig));
 assert.deepEqual(validateReceipt(receipt,expected),receipt);
 assert.throws(()=>validateReceipt({...receipt,revisionId:"b".repeat(64)},expected));
 assert.throws(()=>validateReceipt({...receipt,state:"ADMIN"},expected));
});

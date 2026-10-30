import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const lab=JSON.parse(readFileSync(new URL("../ops/qualification/aws/stack.json",import.meta.url),"utf8"));
const wf=readFileSync(new URL("../.github/workflows/aws-multi-host-qualification.yml",import.meta.url),"utf8");
const py=readFileSync(new URL("../scripts/qualification/aws-live.py",import.meta.url),"utf8");
const R=lab.Resources;
test("qualification creates three real, individually hosted EC2 machines across two AZs",()=>{
  for(const name of ["Control","ApiA","ApiB"]){
    const host=R[name];
    assert.equal(host.Type,"AWS::EC2::Instance");
    assert.equal(host.Properties.MetadataOptions.HttpTokens,"required");
    assert.equal(host.Properties.InstanceInitiatedShutdownBehavior,"terminate");
    assert.equal(host.Properties.BlockDeviceMappings[0].Ebs.DeleteOnTermination,true);
    assert.equal(host.Properties.BlockDeviceMappings[0].Ebs.Encrypted,true);
  }
  assert.equal(R.ApiA.Properties.SubnetId.Ref,"SubnetA");
  assert.equal(R.ApiB.Properties.SubnetId.Ref,"SubnetB");
  assert.equal(R.SubnetA.Properties.AvailabilityZone["Fn::Select"][0],0);
  assert.equal(R.SubnetB.Properties.AvailabilityZone["Fn::Select"][0],1);
  assert.match(R.ApiA.Properties.UserData["Fn::Base64"]["Fn::Sub"],/shutdown -h \+150/);
});
test("no inbound internet ports, no SSH keys, SSM access only",()=>{
  const network=R.ClusterSecurityGroup.Properties;
  assert.equal(network.SecurityGroupIngress,undefined);
  assert.equal(R.PrivateClusterTraffic.Properties.SourceSecurityGroupId.Ref,"ClusterSecurityGroup");
  for(const name of ["Control","ApiA","ApiB"])assert.equal(R[name].Properties.KeyName,undefined);
  assert.ok(R.InstanceRole.Properties.ManagedPolicyArns.some(x=>x.endsWith("AmazonSSMManagedInstanceCore")));
});
test("the private evidence bucket has no public access and expires captured objects",()=>{
  const b=R.EvidenceBucket.Properties;
  assert.ok(Object.values(b.PublicAccessBlockConfiguration).every(Boolean));
  assert.equal(b.LifecycleConfiguration.Rules[0].ExpirationInDays,1);
  assert.equal(b.BucketEncryption.ServerSideEncryptionConfiguration[0].ServerSideEncryptionByDefault.SSEAlgorithm,"AES256");
});
test("automatic AWS provisioning requires deliberate dispatch, IAM OIDC, and teardown",()=>{
  assert.match(wf,/workflow_dispatch:/);
  assert.match(wf,/PROVISION_ISOLATED_AWS_AND_ACCEPT_COST/);
  assert.match(wf,/id-token: write/);
  assert.match(wf,/configure-aws-credentials@v4/);
  assert.match(wf,/cloudformation deploy/);
  assert.match(wf,/if: always\(\)/);
  assert.match(wf,/aws cloudformation delete-stack/);
  assert.match(wf,/stack-delete-complete/);
  assert.doesNotMatch(wf,/pull_request_target:/);
});
test("real host kernels, AZs, remote live APIs and writes are verified, not invented",()=>{
  for(const snippet of ["require_ssm(ids)","/proc/sys/kernel/random/boot_id",
    "ApiAZone", "ApiBZone", "api-instances.json", "certify-multi-process.mjs",
    "totalPersistedChangesets","fullEndToEndCertification","ThreadPoolExecutor(max_workers=3)",
    "remote_writer(i)","real-writers/","physical-writers.json"])assert.ok(py.includes(snippet),snippet);
  assert.match(py,/len\(\{h\["boot"\] for h in attestation\}\) != 3/);
});

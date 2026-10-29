import test from "node:test";
import assert from "node:assert/strict";
import { compareMeasuredBaseline, quantile, qualificationStatus, requiredStages,
  requiredScaleCases, summarizeSamples } from "../scripts/qualification/core.mjs";

test("empirical nearest-rank percentiles preserve real samples",()=>{
  assert.equal(quantile([9,1,3,5,7],.5),5);
  assert.equal(quantile([9,1,3,5,7],.99),9);
  assert.equal(quantile([],.5),null);
  assert.deepEqual(summarizeSamples([3,1]),{count:2,p50:1,p95:3,p99:3});
});
test("no measured baseline means no invented acceptance threshold",()=>{
  assert.equal(compareMeasuredBaseline({p95Ms:1,throughputPerSecond:1},null).status,"UNBASELINED");
  assert.equal(compareMeasuredBaseline({p95Ms:1,throughputPerSecond:1},{runs:[]}).status,"UNBASELINED");
});
test("only comparable complete runs yield a measured envelope",()=>{
  const baseline={topologyHash:"t",workloadHash:"w",runs:[
    {status:"PASSED",topologyHash:"t",workloadHash:"w",p95Ms:10,throughputPerSecond:100},
    {status:"PASSED",topologyHash:"t",workloadHash:"w",p95Ms:11,throughputPerSecond:102},
    {status:"PASSED",topologyHash:"t",workloadHash:"w",p95Ms:12,throughputPerSecond:98},
  ]};
  const current={topologyHash:"t",workloadHash:"w",p95Ms:11,throughputPerSecond:100};
  assert.equal(compareMeasuredBaseline(current,baseline).status,"PASSED");
  assert.equal(compareMeasuredBaseline({...current,p95Ms:40},baseline).status,"REGRESSION");
  assert.equal(compareMeasuredBaseline({...current,throughputPerSecond:0},baseline).status,"REGRESSION");
  assert.equal(compareMeasuredBaseline({...current,topologyHash:"different"},baseline).status,"INCOMPARABLE");
  assert.equal(compareMeasuredBaseline(current,{...baseline,runs:[...baseline.runs.slice(0,2),{...baseline.runs[2],status:"FAILED"}]}).status,"INCOMPARABLE");
});
test("admission and a zero exit status do not satisfy end-to-end evidence",()=>{
  const incomplete=qualificationStatus([
    {name:"publication",stage:"publication",status:"PASSED"},
    {name:"integration-admission",status:"PASSED"},
    {name:"synthetic-cache",status:"NONQUALIFYING"},
  ]);
  assert.equal(incomplete.status,"INCOMPLETE");
  assert.equal(incomplete.stages["integration-completed"],"NOT_MEASURED");
  assert.equal(incomplete.stages["object-storage"],"NOT_MEASURED");
});
test("full certification needs all actual stages and workload cases",()=>{
  const stages=requiredStages.map(stage=>({name:stage,stage,status:"PASSED"}));
  assert.equal(qualificationStatus(stages,{full:true}).status,"INCOMPLETE");
  const cases=requiredScaleCases.map(c=>({name:c,case:c,status:"PASSED"}));
  assert.equal(qualificationStatus([...stages,...cases],{full:true}).status,"QUALIFIED");
  assert.equal(qualificationStatus([...stages,...cases,{name:"failure",status:"FAILED"}],{full:true}).status,"FAILED");
});

#!/usr/bin/env node
// Construct a comparable evidence baseline from >=3 unedited successful runs.
// Accept publication samples only; do not label the lifecycle as certified.
import { readFile, writeFile } from "node:fs/promises";
import { compareMeasuredBaseline } from "./core.mjs";

const args=process.argv.slice(2);
const output=args.find(x=>x.startsWith("--output="))?.slice(9);
const files=args.filter(x=>!x.startsWith("--"));
if(!output||files.length<3)throw Error("Usage: node baseline.mjs --output=baseline.json run1/summary.json run2/summary.json run3/summary.json");
const runs=[];
for(const file of files){
  const summary=JSON.parse(await readFile(file,"utf8"));
  const phase=summary.results?.find(x=>x.name==="native-lifecycle");
  if(phase?.status!=="PASSED" || !phase.evidence ||
    !Number.isFinite(phase.evidence.p95Ms) ||
    !Number.isFinite(phase.evidence.throughputPerSecond) ||
    !phase.evidence.topologyHash || !phase.evidence.workloadHash)
    throw Error(file+" lacks a completed publication phase with comparable measured values");
  runs.push({status:"PASSED",sourceFile:file,runId:summary.runId,
    topologyHash:phase.evidence.topologyHash,workloadHash:phase.evidence.workloadHash,
    p95Ms:phase.evidence.p95Ms,throughputPerSecond:phase.evidence.throughputPerSecond});
}
if(new Set(runs.map(x=>x.topologyHash)).size!==1 ||
   new Set(runs.map(x=>x.workloadHash)).size!==1 ||
   new Set(runs.map(x=>x.runId)).size!==runs.length)
  throw Error("Runs must have unique IDs and matching recorded topology/workload");
const baseline={schemaVersion:1,topologyHash:runs[0].topologyHash,
  workloadHash:runs[0].workloadHash,runs,
  createdAt:new Date().toISOString(),source:"repeated unedited measured native-publication summaries",
  caveat:"This measures publication only. It is not an end-to-end service-level objective."};
const check=compareMeasuredBaseline({...runs[0]},baseline);
if(check.status!=="PASSED")throw Error("Baseline self-check failed: "+check.status);
await writeFile(output,JSON.stringify(baseline,null,2)+"\n",{flag:"wx",mode:0o600});
console.log(JSON.stringify({created:output,runs:runs.length,derivedEnvelope:check}));

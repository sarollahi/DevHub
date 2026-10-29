#!/usr/bin/env node
/**
 * Three independent real-object native publication runs on the SAME isolated
 * topology. Every measurement is retained; failures stop baseline creation.
 * The subsequent qualification run must be independent of these three.
 */
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve,join } from "node:path";
import { digestManifest, compareMeasuredBaseline } from "./core.mjs";

const val=(key)=>process.argv.find(x=>x.startsWith("--"+key+"="))?.slice(key.length+3);
const output=resolve(val("output")??"artifacts/qualification/baselines");
const topologyFile=val("topology");
const iterations=Number(val("runs")??"3");
if(process.env.DEVHUB_QUALIFICATION_ISOLATED!=="YES" ||
   process.env.DEVHUB_QUALIFICATION_APPROVAL!=="RUN_FULL_SCALE" ||
   !topologyFile||!Number.isSafeInteger(iterations)||iterations<3||iterations>10)
  throw Error("Require isolation, manual confirmation, --topology and 3..10 measured runs");
const topology=JSON.parse(await readFile(topologyFile,"utf8"));
if(topology.isolated!==true || topology.replicas?.api<2)
  throw Error("Refusing baseline against unverified topology declaration");
const topologyHash=digestManifest(topology);
const size={submissions:1000,changesets:10000,concurrency:1000,blobs:256};
const workloadHash=digestManifest({kind:"native-independent-publication",
  ...size,objects:size.blobs,blobs:undefined});
await mkdir(output,{recursive:true});
const runs=[];
for(let i=0;i<iterations;i++){
  const directory=join(output,"repeat-"+String(i+1));
  await mkdir(directory,{recursive:true});
  const stdout=createWriteStream(join(directory,"stdout.log"));
  const stderr=createWriteStream(join(directory,"stderr.log"));
  const file=join(directory,"lifecycle.json");
  const args=["--import","tsx","scripts/bench-lifecycle.ts",
    "--submissions=1000","--changesets=10000","--concurrency=1000",
    "--depth=900","--monorepo-paths=6000","--ref-writers=400",
    "--integration-jobs=400","--ci-jobs=0","--queries=500","--blobs=256",
    "--output="+file];
  const child=spawn(process.execPath,args,{stdio:["ignore","pipe","pipe"],env:process.env});
  child.stdout.pipe(stdout);child.stderr.pipe(stderr);
  let code=null;
  try{code=await new Promise((resolve,reject)=>{
    child.once("close",resolve);child.once("error",reject);
  });}finally{
    stdout.end();stderr.end();
    await Promise.all([new Promise(r=>stdout.on("finish",r)),
      new Promise(r=>stderr.on("finish",r))]);
  }
  let measurement=null;
  try{measurement=JSON.parse(await readFile(file,"utf8"));}
  catch {/* Save raw failure without inventing a successful sample. */}
  const concurrent=measurement?.phases?.concurrent_change_submissions;
  const independent=measurement?.phases?.independent_changeset_publication;
  const passed=code===0&&concurrent?.completed===1000 &&
    independent?.completed===9000 &&
    measurement?.integrity?.persistedAfterIndependentPhase===10001 &&
    !Object.keys(concurrent?.failureCodes??{}).length &&
    Number.isFinite(concurrent?.p95Ms) &&
    Number.isFinite(concurrent?.successfulPerSecond);
  const summary={
    schemaVersion:1,runId:measurement?.runId??null,
    topologyHash,workloadHash,
    results:[{name:"native-lifecycle",status:passed?"PASSED":"FAILED",
      evidence:passed?{topologyHash,workloadHash,
        p95Ms:concurrent.p95Ms,throughputPerSecond:concurrent.successfulPerSecond,
        attempted:concurrent.attempted,completed:concurrent.completed}:null}],
    exitCode:code,source:"scripts/bench-lifecycle.ts",rawFile:"lifecycle.json"};
  await writeFile(join(directory,"summary.json"),JSON.stringify(summary,null,2)+"\n");
  if(!passed)throw Error("Measured baseline repeat "+(i+1)+" failed; inspect unmodified artifacts");
  runs.push({status:"PASSED",runId:measurement.runId,topologyHash,workloadHash,
    p95Ms:concurrent.p95Ms,throughputPerSecond:concurrent.successfulPerSecond,
    sourceFile:join(directory,"lifecycle.json")});
}
if(new Set(runs.map(x=>x.runId)).size!==runs.length)throw Error("Repeated run ID");
const baseline={schemaVersion:1,topologyHash,workloadHash,runs,
  createdAt:new Date().toISOString(),limitation:"Measured native publication; not a complete end-to-end baseline"};
const check=compareMeasuredBaseline(runs[0],baseline);
if(check.status!=="PASSED")throw Error("Measured cohort failed its own baseline check");
await writeFile(join(output,"baseline.json"),JSON.stringify(baseline,null,2)+"\n",{flag:"wx"});
console.log(JSON.stringify({status:"BASELINE_RECORDED",count:runs.length,
  output:join(output,"baseline.json"),envelope:check}));

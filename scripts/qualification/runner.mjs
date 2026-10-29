#!/usr/bin/env node
/**
 * Isolated qualification coordinator. Each case records command, exit status,
 * elapsed time, unmodified stdout/stderr, input topology and raw evidence.
 * A green process return is not by itself a qualification result.
 *
 * Smoke: npm run qualification:smoke
 * Full:  DEVHUB_QUALIFICATION_ISOLATED=YES
 *        DEVHUB_QUALIFICATION_APPROVAL=RUN_FULL_SCALE
 *        DEVHUB_QUALIFICATION_TOPOLOGY_FILE=/path/to/isolated-topology.json
 *        npm run qualification:full
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { cpus, hostname, platform, totalmem } from "node:os";
import { resolve, join } from "node:path";
import { performance } from "node:perf_hooks";
import { compareMeasuredBaseline, qualificationStatus, digestManifest } from "./core.mjs";

const args=new Map(process.argv.slice(2).filter(x=>x.startsWith("--")).map(x=>{
  const [key,...rest]=x.slice(2).split("=");return [key,rest.join("=")];
}));
const full=args.get("profile")==="full";
if(!["smoke","full"].includes(args.get("profile")))
  throw new Error("--profile=smoke|full required");
const only=args.get("only")?.split(",").filter(Boolean);
const destination=resolve(args.get("output")||"artifacts/qualification/"+new Date().toISOString().replace(/[:.]/g,"-"));
const confirmation=process.env.DEVHUB_QUALIFICATION_APPROVAL;
const isolated=process.env.DEVHUB_QUALIFICATION_ISOLATED==="YES";
let topology={mode:"local-ci",isolation:"unverified",replicas:{}};
if(full){
  if(!isolated||confirmation!=="RUN_FULL_SCALE")throw new Error("Full profile requires explicit isolated-environment approval");
  const path=process.env.DEVHUB_QUALIFICATION_TOPOLOGY_FILE;
  if(!path)throw new Error("Full profile needs an independently supplied topology manifest");
  topology=JSON.parse(await readFile(path,"utf8"));
  if(topology.isolated!==true || !topology.replicas ||
      topology.replicas.api<2 || topology.replicas.index<2 ||
      topology.replicas.validation<2 || topology.replicas.integration<2)
    throw new Error("Full profile requires declared isolated multi-instance infrastructure");
}
await mkdir(destination,{recursive:true});
const start=new Date();
const manifest={schemaVersion:1,runId:randomUUID(),profile:full?"full":"smoke",
  startedAt:start.toISOString(),commit:process.env.GITHUB_SHA??"unknown",
  node:process.version,host:hostname(),os:platform(),cpuCount:cpus().length,
  memoryBytes:totalmem(),topology,ciRunId:process.env.GITHUB_RUN_ID??null,
  requestedCases:only??"all"};
const topologyHash=digestManifest(topology);
await writeFile(join(destination,"manifest.json"),JSON.stringify(manifest,null,2)+"\n");
const results=[];
const npm=process.platform==="win32"?"npm.cmd":"npm";
async function run(name,cmd,argv,{timeout=600,env={},parse=null,stage=null,caseName=null}={}){
  if(only && !only.includes(name)) return null;
  const stamp=performance.now();
  const stdoutPath=join(destination,name+".stdout.log");
  const stderrPath=join(destination,name+".stderr.log");
  const stdout=createWriteStream(stdoutPath,{flags:"wx"});
  const stderr=createWriteStream(stderrPath,{flags:"wx"});
  let timedOut=false,code=null,signal=null,error=null;
  const child=spawn(cmd,argv,{env:{...process.env,...env},stdio:["ignore","pipe","pipe"],detached:process.platform!=="win32"});
  child.stdout.pipe(stdout);child.stderr.pipe(stderr);
  const close=async()=>new Promise(r=>{
    let pending=2;const done=()=>{if(!--pending)r();};
    stdout.on("finish",done);stderr.on("finish",done);
    if(stdout.writableFinished)done();if(stderr.writableFinished)done();
  });
  const killer=setTimeout(()=>{
    timedOut=true;
    try {if(process.platform!=="win32")process.kill(-child.pid,"SIGTERM");else child.kill("SIGTERM");}
    catch {}
    setTimeout(()=>{
      try {if(process.platform!=="win32")process.kill(-child.pid,"SIGKILL");else child.kill("SIGKILL");}
      catch {}
    },5000).unref();
  },timeout*1000);
  killer.unref();
  try{
    const end=await new Promise(resolve=>{
      child.once("error",e=>resolve({error:String(e),code:null,signal:null}));
      child.once("close",(c,s)=>resolve({code:c,signal:s,error:null}));
    });
    code=end.code;signal=end.signal;error=end.error;
  } finally {
    clearTimeout(killer);
    if(!stdout.writableEnded)stdout.end();
    if(!stderr.writableEnded)stderr.end();
    await close();
  }
  let status=timedOut?"TIMED_OUT":code===0?"PASSED":"FAILED";
  let evidence=null;
  if(status==="PASSED" && parse){
    try {
      evidence=await parse();
      if(evidence?.accepted===false)status="FAILED";
      if(evidence?.nonqualifying)status="NONQUALIFYING";
    }catch(e){status="FAILED";error="Invalid or missing benchmark evidence: "+String(e);}
  }
  const result={name,stage,case:caseName,status,exitCode:code,signal,error,
    durationSeconds:Number(((performance.now()-stamp)/1000).toFixed(3)),
    command:[cmd,...argv],stdoutPath:name+".stdout.log",stderrPath:name+".stderr.log",
    evidence};
  results.push(result);
  await writeSummary();
  process.stdout.write(JSON.stringify({name,status,durationSeconds:result.durationSeconds})+"\n");
  return result;
}
async function writeSummary(){
  const verification=qualificationStatus(results,{full});
  const report={schemaVersion:1,runId:manifest.runId,profile:manifest.profile,
    startedAt:manifest.startedAt,updatedAt:new Date().toISOString(),
    topologyHash,results,verification,
    caveat:"PASSED means this individual measurement satisfied its asserted invariant; only QUALIFIED means the whole required matrix has evidence"};
  await writeFile(join(destination,"summary.json.tmp"),JSON.stringify(report,null,2)+"\n");
  const {rename}=await import("node:fs/promises");
  await rename(join(destination,"summary.json.tmp"),join(destination,"summary.json"));
}
const readJSON=async path=>JSON.parse(await readFile(join(destination,path),"utf8"));
const executeNpm=(name,script,argv=[],options={})=>
  run(name,npm,["run",script,"--",...argv],options);
try{
  const size=full?{
    submissions:1000,changesets:10000,concurrency:1000,depth:900,paths:6000,
    writers:400,integrations:400,ci:2000,queries:500,blobs:256
  }:{
    submissions:8,changesets:20,concurrency:8,depth:6,paths:40,
    writers:8,integrations:6,ci:0,queries:10,blobs:4
  };
  const lifecycleFile="lifecycle.json";
  const lifecycleArgs=[
    "--submissions="+size.submissions,"--changesets="+size.changesets,
    "--concurrency="+size.concurrency,"--depth="+size.depth,
    "--monorepo-paths="+size.paths,"--ref-writers="+size.writers,
    "--integration-jobs="+size.integrations,"--ci-jobs="+size.ci,
    "--queries="+size.queries,"--blobs="+size.blobs,
    "--output="+join(destination,lifecycleFile),
  ];
  const life=await executeNpm("native-lifecycle","bench:lifecycle",lifecycleArgs,{
    timeout:full?18000:300,stage:"publication",caseName:full?"burst-1000":null,
    parse:async()=>{
      const data=await readJSON(lifecycleFile);
      const first=data.phases?.concurrent_change_submissions;
      const independent=data.phases?.independent_changeset_publication;
      const accepted=first?.completed===size.submissions &&
        first?.attempted===size.submissions &&
        first?.failureCodes && Object.keys(first.failureCodes).length===0 &&
        independent?.completed===size.changesets-size.submissions &&
        data.integrity?.persistedAfterIndependentPhase===size.changesets+1;
      return {accepted,repositoryId:data.repositoryId,
        attempts:first?.attempted,completed:first?.completed,
        throughputPerSecond:first?.successfulPerSecond,
        p50Ms:first?.p50Ms,p95Ms:first?.p95Ms,p99Ms:first?.p99Ms,
        independentCount:data.integrity?.persistedAfterIndependentPhase,
        note:"Native in-process service calls, not HTTP or final integration"};
    }});
  if(life?.status==="PASSED"){
    await run("durable-audit",npm,["exec","--","tsx","scripts/qualification/evidence.ts",
      "--input="+join(destination,lifecycleFile),
      "--output="+join(destination,"durable-evidence.json")],{
      timeout:120,parse:async()=>{
        const data=await readJSON("durable-evidence.json");
        return {accepted:data.publication.persisted>=data.publication.expected,
          stages:data.stages,validation:data.validation,review:data.review,
          integration:data.integration,indexing:data.indexing};
      }});
    const audit=results.at(-1);
    if(audit?.name==="durable-audit" && audit.status==="PASSED"){
      for(const [stage,status] of Object.entries(audit.evidence.stages))
        results.push({name:"database-"+stage,stage,status,case:null,
          evidence:{source:"durable-evidence.json"}});
      await writeSummary();
    }
  }
  if(full){
    // Real S3/MinIO streaming; never substitute inline canonical BLOB bytes.
    await executeNpm("physical-object-store","storage:stress",[],{
      timeout:3600,stage:"object-storage",
      parse:async()=>{
        const raw=await readFile(join(destination,"physical-object-store.stdout.log"),"utf8");
        const event=raw.split("\n").filter(Boolean).map(x=>{try{return JSON.parse(x)}catch{return null}})
          .find(x=>x?.event==="object_storage.stress_measured");
        return {accepted:event?.verified===true && event.bytes===3*1024**3,
          bytes:event?.bytes??null,storedBytes:event?.encodedBytes??null,
          peakRssBytes:event?.peakRss??null};
      }});
  }
  await executeNpm("source-queries","bench:source-query",[
    "--depth="+(full?900:30),"--width="+(full?40:6),"--layers="+(full?25:4)],{
      timeout:full?1500:120});
  await executeNpm("atomic-reference-race","bench:integration:db",[],{
    timeout:full?1500:180,stage:"atomic-ref",caseName:full?"integration-race":null,
    parse:async()=>{
      const raw=await readFile(join(destination,"atomic-reference-race.stdout.log"),"utf8");
      const p=raw.indexOf("{");if(p<0)throw Error("Missing machine-readable race record");
      const data=JSON.parse(raw.slice(p));
      return {accepted:data.winningUpdates===1&&data.rejectedStaleWriters===119&&
        data.refGeneration===2, CAS:data.refCas,
        caveat:"Real competing ref CAS; integration admission, not completed merge"};
    }});
  await executeNpm("cache-local-control","cache:benchmark",[],{
    timeout:300,parse:async()=>({nonqualifying:true,reason:"localhost synthetic origin; not a native regional cache"})});
  if(full){
    const seed=async(name)=>{
      const file=join(destination,name+"-seed.json");
      const result=await run(name+"-seed",npm,["exec","--","tsx","scripts/qualification/seed.ts",
        "--output="+file],{timeout:300});
      return result?.status==="PASSED"?file:null;
    };
    const deepSeed=await seed("history");
    const pathSeed=await seed("files");
    const scale=async(name,mode,count,seedPath,timeout)=>{
      if(!seedPath) return;
      return run(name,npm,["exec","--","tsx","scripts/qualification/scale.ts",
        "--seed="+seedPath,"--checkpoint="+join(destination,mode+"-checkpoint.json"),
        "--report="+join(destination,name+".jsonl"),
        "--mode="+mode,"--count="+count],{
          timeout,caseName:name,
          parse:async()=>{
            const raw=await readFile(join(destination,name+".jsonl"),"utf8");
            const last=JSON.parse(raw.trim().split("\n").at(-1));
            return {accepted:last.phase==="complete"&&last.completed===count &&
              last.fileCount===(mode==="paths"?count+1:1),
              completed:last.completed,files:last.fileCount,
              p95Ms:last.latencyReservoir?.p95Ms??null,
              throughputPerSecond:last.throughputPerSecond??null,
              sampleWarning:"bounded reservoir of genuine operations"};
          }});
    };
    await scale("history-100000","history",100000,deepSeed,36000);
    await scale("history-1000000","history",1000000,deepSeed,259200);
    await scale("files-100000","paths",100000,pathSeed,18000);
    await scale("files-1000000","paths",1000000,pathSeed,86400);
  }
  // A lifecycle report with QUEUED validations or integrations is not an
  // end-to-end completion measurement. Unrun service restart and partition
  // scenarios remain NOT_MEASURED, never implicit passes.
  await writeSummary();
  const failed=results.some(r=>["FAILED","TIMED_OUT"].includes(r.status));
  const report=qualificationStatus(results,{full});
  process.stdout.write(JSON.stringify({runId:manifest.runId,destination,
    status:report.status,failedCases:report.failedCases})+"\n");
  if(failed || (full && report.status!=="QUALIFIED"))process.exitCode=1;
} catch(error){
  results.push({name:"coordinator",status:"FAILED",
    error:error instanceof Error?error.message:String(error)});
  await writeSummary();
  process.exitCode=1;
  console.error(error);
}

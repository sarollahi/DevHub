/**
 * Large native benchmark: real immutable changesets, verified BLOBs and
 * incremental trees. Safe resume via a durable checkpoint; every batch is
 * followed by persisted-state verification. Never a synthetic PR workload.
 */
import { readFile, writeFile, rename, mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { db } from "../../src/lib/prisma";
import { createCanonicalChangeset, getCanonicalSnapshotPage } from "../../src/source-control/canonical";
import { SnapshotTree } from "../../src/source-control/snapshot-tree";

const flags = new Map(process.argv.slice(2).map(x => {
  const [k,...v] = x.replace(/^--/,"").split("="); return [k,v.join("=")];
}));
const seedPath = flags.get("seed");
const checkpointPath = flags.get("checkpoint");
const reportPath = flags.get("report");
const mode = flags.get("mode");
const count = Number(flags.get("count"));
if (process.env.DEVHUB_QUALIFICATION_ISOLATED !== "YES" ||
    !seedPath || !checkpointPath || !reportPath || !["paths","history"].includes(mode ?? "") ||
    !Number.isSafeInteger(count) || count < 1 || count > 1_000_000)
  throw new Error("Isolated --seed, --checkpoint, --report, --mode=paths|history and --count=1..1000000 required");
const seed = JSON.parse(await readFile(seedPath,"utf8"));
if (!seed.disposable || !Array.isArray(seed.objectIds) || seed.objectIds.length < 2)
  throw new Error("Seed must contain multiple genuine distinct immutable objects");
const actor = {type:"AGENT" as const,id:seed.actorId,credentialId:seed.credentialId};
const repo = seed.repositoryId as string;
const interval = mode === "paths" ? 4000 : 250;
const checkpoint = async (data: object) => {
  await writeFile(checkpointPath+".tmp",JSON.stringify(data,null,2)+"\n",{mode:0o600});
  await rename(checkpointPath+".tmp",checkpointPath);
};
const log = async (data: object) => appendFile(reportPath,JSON.stringify({
  time:new Date().toISOString(),mode,requested:count,...data})+"\n");
await mkdir(dirname(reportPath),{recursive:true});
await mkdir(dirname(checkpointPath),{recursive:true});
let prior: {seedPath:string;mode:string;completed:number;head:string;status:string} | undefined;
try { prior = JSON.parse(await readFile(checkpointPath,"utf8")); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
if (prior && (prior.mode !== mode || prior.seedPath !== seedPath || prior.completed > count))
  throw new Error("Checkpoint belongs to another mode/seed or exceeds requested count");
let completed = prior?.completed ?? 0;
let head = prior?.head;
const samples:number[] = [];
const sampleCap=4096;
let peakRss=process.memoryUsage().rss;
const start=performance.now(), cpu=process.cpuUsage();
let checked=0;
const quantiles = (arr:number[]) => {
  const sorted=[...arr].sort((a,b)=>a-b);
  return {samples:sorted.length,p50Ms:sorted[Math.ceil(sorted.length*.5)-1]??null,
    p95Ms:sorted[Math.ceil(sorted.length*.95)-1]??null,
    p99Ms:sorted[Math.ceil(sorted.length*.99)-1]??null};
};
try {
  if (!head) {
    const root=await createCanonicalChangeset(repo,actor,{apiVersion:2,parents:[],
      description:"Qualification actual-content root",
      operations:[{kind:"ADD",path:"scale/active.txt",objectId:seed.objectIds[0]}]});
    head=root.id;
    await checkpoint({seedPath,mode,completed,head,status:"IN_PROGRESS"});
    await log({phase:"root",head});
  } else {
    const exists=await db.sourceChangeset.findFirst({where:{id:head,repositoryId:repo},select:{id:true}});
    if (!exists) throw new Error("Checkpoint head does not exist in authoritative repository");
  }
  for (let i=completed; i<count;) {
    const begin=performance.now();
    if (mode === "paths") {
      const size=Math.min(4000,count-i);
      const operations=Array.from({length:size},(_,j)=>({kind:"ADD" as const,
        path:"scale/files/"+String(i+j).padStart(10,"0"),
        objectId:seed.objectIds[(i+j)%seed.objectIds.length]}));
      const revision=await createCanonicalChangeset(repo,actor,{apiVersion:2,parents:[head!],
        description:"Qualification add files "+i+".."+(i+size-1),operations});
      head=revision.id;i+=size;
    } else {
      const revision=await createCanonicalChangeset(repo,actor,{apiVersion:2,parents:[head!],
        description:"Qualification history revision "+(i+1),
        operations:[{kind:"MODIFY",path:"scale/active.txt",
          objectId:seed.objectIds[(i+1)%seed.objectIds.length]}]});
      head=revision.id;i++;
    }
    completed=i;
    const latency=performance.now()-begin;
    // Deterministic bounded reservoir: no pretend full-sample percentile.
    if (samples.length<sampleCap) samples.push(latency);
    else {const slot=(i*2654435761>>>0) % i;if(slot<sampleCap)samples[slot]=latency;}
    peakRss=Math.max(peakRss,process.memoryUsage().rss);
    if (completed % interval===0 || completed===count) {
      const page=await getCanonicalSnapshotPage(repo,head!,actor,1);
      if (!page.entries.length) throw new Error("Authoritative snapshot unreadable");
      checked++;
      await checkpoint({seedPath,mode,completed,head,status:completed===count?"COMPLETE":"IN_PROGRESS"});
      await log({phase:"progress",completed,head,elapsedMs:performance.now()-start,
        recentOperationMs:latency,reservoir:quantiles(samples),peakRssBytes:peakRss});
    }
  }
  const root=await db.sourceSnapshotRoot.findUniqueOrThrow({where:{changesetId:head!}});
  const fileCount=await new SnapshotTree(db).count(root.rootId);
  const expected=mode==="paths"?count+1:1;
  if(fileCount!==expected)throw new Error("Persisted tree expected "+expected+" files, found "+fileCount);
  const usage=process.cpuUsage(cpu);
  const result={phase:"complete",mode,requested:count,completed,head,fileCount,
    persistedSnapshotRoot:root.rootId,checkpointChecks:checked,
    elapsedMs:performance.now()-start,
    throughputPerSecond:completed*1000/(performance.now()-start),
    latencyReservoir:quantiles(samples),peakRssBytes:peakRss,
    cpuUserUs:usage.user,cpuSystemUs:usage.system,
    sampling:"bounded reservoir only; not a complete per-operation latency trace",
    limitation:"This run measures one driver process and local service APIs, not an HTTP ingress or multi-node deployment"};
  await log(result); process.stdout.write(JSON.stringify(result)+"\n");
} catch(error) {
  await log({phase:"failed",completed,head,error:error instanceof Error?error.message:String(error)});
  process.exitCode=1;
  console.error(error);
} finally {await db.$disconnect();}

import { createHash, randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, chmod, symlink, readdir, lstat, readFile, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { tmpdir, hostname } from "node:os";
import { join, dirname } from "node:path";
import { Prisma, type ValidationTask } from "@prisma/client";
import { db } from "../lib/prisma";
import { fairCandidates, fairClaim } from "../workers/tenant-scheduler";
import { validPath } from "../lib/review-logic";
import { snapshotFor, verifiedBlobSource, type Entry } from "./snapshot";
import { digest, signTask, verifyTask } from "./policy";
import { refreshPipeline } from "./service";
import { readContainerUsage, mergeContainerUsage, type ContainerUsage } from "./container-usage";

const exec = promisify(execFile);
const leaseMs = 45_000;
const maxLog = 4 * 1024 * 1024;
const maxArtifact = 2 * 1024 * 1024;
const maxArtifacts = 8 * 1024 * 1024;
type Claimed = ValidationTask & {
  oldLeaseToken?: string | null;
  pipeline: { repositoryId:string; changesetId:string; targetChangesetId:string|null;
    snapshotDigest:string; dependencyDigest:string };
};
function containerName(taskId:string, token:string|null|undefined) {
  return "devhub-val-" + taskId.replaceAll("-","") + "-" + (token || "").replaceAll("-","");
}
async function terminateContainer(name:string) {
  await exec("docker",["rm","-f",name],{timeout:10000}).catch(()=>undefined);
}
export async function claimTask():Promise<Claimed|null> {
  const candidates = await fairCandidates("validation");
  for (const candidate of candidates) {
    const claimed = await fairClaim("validation", candidate.tenantId, async tx => {
      const before = await tx.validationTask.findUnique({
        where: { id: candidate.id }, include: { pipeline: true },
      });
      if (!before || before.pipeline.state === "CANCELLED" ||
          before.attempt >= before.maxAttempts) return null;
      const now = new Date();
      const eligible = (before.state === "QUEUED" && before.nextAttemptAt <= now) ||
        (before.state === "RUNNING" && !!before.leaseUntil && before.leaseUntil < now);
      if (!eligible) return null;
      const token = randomUUID();
      const selected = await tx.validationTask.updateMany({ where: {
        id: before.id, state: before.state, attempt: before.attempt,
        ...(before.state === "RUNNING" ? { leaseUntil: { lt: now } } :
          { nextAttemptAt: { lte: now } }),
      }, data: {
        state: "RUNNING", leaseToken: token, leaseUntil: new Date(Date.now()+leaseMs),
        attempt: { increment: 1 }, startedAt: new Date(), finishedAt: null,
        signature: null, exitCode: null, summary: null, runnerId: hostname()+":"+process.pid,
      } });
      if (!selected.count) return null;
      const task = await tx.validationTask.findUniqueOrThrow({ where: { id: before.id },
        include: { pipeline: { select: {
          repositoryId: true, changesetId: true, targetChangesetId: true,
          snapshotDigest: true, dependencyDigest: true,
        } } },
      });
      await tx.validationPipeline.updateMany({ where: { id: task.pipelineId, state: "QUEUED" },
        data: { state: "RUNNING" } });
      return { ...task, oldLeaseToken: before.leaseToken };
    });
    if (claimed) return claimed;
  }
  return null;
}
async function materialize(root:string,entries:Entry[],repoId:string) {
  const links:Array<{path:string;bytes:Buffer}>=[];
  let count=0;
  for(const entry of entries) {
    if(!validPath(entry.path))throw new Error("Invalid immutable path");
    if(++count>250000)throw new Error("Workspace has too many files");
    const path=join(root,entry.path);
    const contents=await verifiedBlobSource(entry.objectId,repoId);
    if(entry.mode==="120000"){
      let total=0;const chunks:Buffer[]=[];
      for await(const chunk of contents) {
        const part=Buffer.from(chunk);
        total+=part.length;
        if(total>4096)throw new Error("Symlink target exceeds maximum size");
        chunks.push(part);
      }
      links.push({path,bytes:Buffer.concat(chunks)});
      continue;
    }
    if(!["100644","100755"].includes(entry.mode))throw new Error("Unsupported immutable file mode");
    await mkdir(dirname(path),{recursive:true});
    // VerifiedBlobStream fails closed on corrupt or truncated remote objects.
    await pipeline(contents,createWriteStream(path,{flags:"wx",
      mode:entry.mode==="100755"?0o755:0o644}));
  }
  // Link creation follows writes so no source materialization traverses untrusted links.
  for(const link of links){
    await mkdir(dirname(link.path),{recursive:true});
    const target=new TextDecoder("utf-8",{fatal:true}).decode(link.bytes);
    if(target.startsWith("/")||target.includes("\0"))throw new Error("Unsafe symlink");
    await symlink(target,link.path);
  }
  await chmod(root,0o755);
}
async function recordArtifacts(task:Claimed,root:string) {
  let total=0;
  const hashes:Array<[string,string]>=[];
  const pending:Array<{taskId:string;attempt:number;name:string;mediaType:string;digest:string;content:Uint8Array<ArrayBuffer>}>=[];
  async function visit(dir:string,prefix=""):Promise<void> {
    for(const name of (await readdir(dir)).sort()) {
      const relative=prefix?prefix+"/"+name:name;
      if(!validPath(relative)||relative.length>256) throw new Error("Invalid artifact path");
      const path=join(dir,name),stat=await lstat(path);
      if(stat.isDirectory()) {await visit(path,relative);continue;}
      if(!stat.isFile()||stat.size>maxArtifact||total+stat.size>maxArtifacts)
        throw new Error("Artifact policy limit exceeded");
      const bytes=await readFile(path);
      total+=bytes.length;
      const hash=digest(bytes);
      hashes.push([relative,hash]);
      pending.push({taskId:task.id,attempt:task.attempt,name:relative,mediaType:"application/octet-stream",digest:hash,content:Uint8Array.from(bytes)});
    }
  }
  await visit(root);
  if(pending.length) await db.$transaction(async tx => {
    // Publishing artifacts must be fenced by a live lease. A process that
    // survived past expiry cannot append evidence after another worker claims.
    const owned = await tx.$queryRaw<Array<{id: string}>>`
      SELECT id FROM "ValidationTask" WHERE id=${task.id}::uuid
        AND "leaseToken"=${task.leaseToken}::uuid
        AND state='RUNNING' AND "leaseUntil">now() FOR UPDATE`;
    if (!owned.length) throw Error("Validation lease expired before artifact publication");
    await tx.validationArtifact.createMany({data:pending});
  });
  return digest(JSON.stringify(hashes.sort(([a],[b])=>a.localeCompare(b))));
}
async function capture(task:Claimed,source:string,artifacts:string,isCancelled:()=>boolean) {
  const name=containerName(task.id,task.leaseToken);
  const args=["run","--rm","--pull=never","--name",name,"--network=none","--read-only",
    "--cap-drop=ALL","--security-opt=no-new-privileges","--pids-limit=128",
    "--memory=1024m","--cpus=1.5","--user=65534:65534","--init",
    "--tmpfs","/work:rw,exec,nosuid,nodev,size=640m",
    "--tmpfs","/tmp:rw,nosuid,nodev,size=96m",
    "--mount","type=bind,src="+source+",dst=/source,readonly",
    "--mount","type=bind,src="+artifacts+",dst=/artifacts",
    "--env","HOME=/tmp","--env","npm_config_cache=/tmp/npm-cache",
    "--entrypoint","/bin/sh",task.image,"-ec",task.command];
  const child=spawn("docker",args,{stdio:["ignore","pipe","pipe"],env:{
    PATH:process.env.PATH||"/usr/bin:/bin", NODE_ENV:process.env.NODE_ENV||"production",
    DOCKER_HOST:process.env.VALIDATION_DOCKER_HOST||"unix:///var/run/docker.sock"
  }});
  const hash=createHash("sha256");
  let length=0,sequence=0,chain=Promise.resolve();
  function output(chunk:Buffer,label:string) {
    if(length>=maxLog)return;
    const content=Buffer.concat([Buffer.from(label),chunk]).subarray(0,maxLog-length).toString("utf8");
    length+=Buffer.byteLength(content,"utf8");hash.update(content);sequence++;
    const index=sequence;
    chain=chain.then(async()=>{
      const owned=await db.validationTask.count({where:{id:task.id,leaseToken:task.leaseToken,state:"RUNNING",leaseUntil:{gt:new Date()}}});
      if(owned) await db.validationLogChunk.create({data:{taskId:task.id,attempt:task.attempt,sequence:index,content}});
    });
  }
  child.stdout.on("data",(b:Buffer)=>{child.stdout.pause();output(b,"");void chain.finally(()=>child.stdout.resume());});
  child.stderr.on("data",(b:Buffer)=>{child.stderr.pause();output(b,"[stderr] ");void chain.finally(()=>child.stderr.resume());});
  let timeout=false,cancelled=false;
  const usageRef: { current: ContainerUsage | null } = { current: null };
  let sampling = false;
  const sampleUsage = () => {
    if (sampling) return;
    sampling = true;
    void readContainerUsage(name).then(result => {
      usageRef.current = mergeContainerUsage(usageRef.current, result);
    }).finally(() => { sampling = false; });
  };
  const meter = setInterval(sampleUsage, 1000);
  const started=Date.now();
  const timer=setInterval(()=>{
    if(Date.now()-started>task.timeoutSeconds*1000)timeout=true;
    else if(isCancelled())cancelled=true;
    if(timeout||cancelled){child.kill("SIGTERM");void terminateContainer(name);}
  },1000);
  try {
    const result=await new Promise<{code:number|null;error:Error|null}>(resolve=>{
      child.once("close",code=>resolve({code,error:null}));
      child.once("error",error=>resolve({code:null,error}));
    });
    await chain;
    return {...result,timeout,cancelled,logDigest:hash.digest("hex"),usage: usageRef.current};
  } finally {clearInterval(timer);clearInterval(meter);await terminateContainer(name);}
}
export async function executeTask(task:Claimed) {
  if(task.oldLeaseToken)await terminateContainer(containerName(task.id,task.oldLeaseToken));
  let root:string|null=null,cancelled=false;
  let heartbeat:ReturnType<typeof setInterval>|null=null;
  try {
    const snapshot=await snapshotFor(task.pipeline.repositoryId,task.pipeline.changesetId,
      task.pipeline.targetChangesetId);
    if(snapshot.digest!==task.pipeline.snapshotDigest||
      snapshot.dependencyDigest!==task.pipeline.dependencyDigest)throw new Error("Snapshot changed");
    const reusable=await db.validationTask.findFirst({where:{fingerprint:task.fingerprint,
      state:"PASSED",signature:{not:null},NOT:{id:task.id}},orderBy:{finishedAt:"desc"}});
    if(reusable&&verifyTask(reusable)) {
      const [logs,artifacts]=await Promise.all([
        db.validationLogChunk.findMany({where:{taskId:reusable.id,attempt:reusable.attempt},
          orderBy:{sequence:"asc"}}),
        db.validationArtifact.findMany({where:{taskId:reusable.id,attempt:reusable.attempt},
          orderBy:{name:"asc"}}),
      ]);
      const evidenceMatches=digest(logs.map(x=>x.content).join(""))===reusable.logDigest &&
        digest(JSON.stringify(artifacts.map(x=>[x.name,x.digest])))===reusable.artifactDigest &&
        artifacts.every(x=>digest(x.content)===x.digest);
      if(evidenceMatches) {
        const signed={...task,state:"PASSED" as const,exitCode:0,
          logDigest:reusable.logDigest,artifactDigest:reusable.artifactDigest,reusedFromId:reusable.id};
        const signature=signTask(signed);
        await db.$transaction(async tx=>{
          const owned=await tx.validationTask.findFirst({where:{
            id:task.id,state:"RUNNING",leaseToken:task.leaseToken,leaseUntil:{gt:new Date()}}});
          if(!owned)return;
          if(logs.length)await tx.validationLogChunk.createMany({data:logs.map(x=>({
            taskId:task.id,attempt:task.attempt,sequence:x.sequence,content:x.content
          }))});
          if(artifacts.length)await tx.validationArtifact.createMany({data:artifacts.map(x=>({
            taskId:task.id,attempt:task.attempt,name:x.name,mediaType:x.mediaType,
            digest:x.digest,content:Uint8Array.from(x.content)
          }))});
          await tx.validationTask.updateMany({where:{id:task.id,state:"RUNNING",leaseToken:task.leaseToken,leaseUntil:{gt:new Date()}},
            data:{state:"PASSED",signature,exitCode:0,logDigest:reusable.logDigest,
              artifactDigest:reusable.artifactDigest,reusedFromId:reusable.id,
              summary:"Reused signed result and verified stored evidence for identical immutable inputs",
               resourceMeasurementStatus:"REUSED",
              finishedAt:new Date(),leaseUntil:null,leaseToken:null}});
        });
        return;
      }
    }
    root=await mkdtemp(join(tmpdir(),"devhub-validation-"));
    await chmod(root,0o755);
    const source=join(root,"source"),artifacts=join(root,"artifacts");
    await mkdir(source);await mkdir(artifacts,{mode:0o777});await chmod(artifacts,0o777);
    await materialize(source,snapshot.entries,task.pipeline.repositoryId);
    heartbeat=setInterval(()=>{
      void db.validationTask.updateMany({where:{id:task.id,state:"RUNNING",leaseToken:task.leaseToken,leaseUntil:{gt:new Date()}},
        data:{leaseUntil:new Date(Date.now()+leaseMs)}})
        .then(x=>{if(!x.count)cancelled=true;}).catch(()=>{cancelled=true;});
    },10000);
    const poll=setInterval(()=>{
      void db.validationTask.findUnique({where:{id:task.id},select:{state:true,leaseToken:true}})
        .then(x=>{if(x?.state!=="RUNNING"||x.leaseToken!==task.leaseToken)cancelled=true;})
        .catch(()=>{cancelled=true;});
    },1500);
    let result;
    try {result=await capture(task,source,artifacts,()=>cancelled);}
    finally {clearInterval(poll);}
    if(cancelled||result.cancelled)return;
    const artifactDigest=await recordArtifacts(task,artifacts);
    const state=result.timeout?"TIMED_OUT" as const:result.error?"ERRORED" as const:
      result.code===0?"PASSED" as const:"FAILED" as const;
    const signed={...task,state,exitCode:result.code,logDigest:result.logDigest,
      artifactDigest,reusedFromId:null};
    const signature=signTask(signed);
    await db.validationTask.updateMany({where:{id:task.id,state:"RUNNING",leaseToken:task.leaseToken,leaseUntil:{gt:new Date()}},
      data:{state,signature,exitCode:result.code,logDigest:result.logDigest,
        measuredCpuNanos:result.usage?.cpuNanos??null,
        sampledMemoryPeakBytes:result.usage?.sampledMemoryPeakBytes??null,
        containerNetworkRxBytes:result.usage?.networkRxBytes??null,
        containerNetworkTxBytes:result.usage?.networkTxBytes??null,
        resourceMeasurementStatus:result.usage?"SAMPLED":"UNAVAILABLE",
        artifactDigest,finishedAt:new Date(),leaseUntil:null,leaseToken:null,
        summary:result.timeout?"Timed out":result.error?.message||
          (result.code===0?"Passed":"Exit code "+result.code)}});
  } catch(error) {
    const exhausted=task.attempt>=task.maxAttempts;
    await db.validationTask.updateMany({where:{id:task.id,state:"RUNNING",leaseToken:task.leaseToken,leaseUntil:{gt:new Date()}},
      data:{state:exhausted?"ERRORED":"QUEUED",leaseToken:null,leaseUntil:null,
        summary:error instanceof Error?error.message.slice(0,400):"Runner error",
        nextAttemptAt:new Date(Date.now()+Math.min(60000,1000*2**Math.min(8,task.attempt))),
        finishedAt:exhausted?new Date():null}});
  } finally {
    if(heartbeat)clearInterval(heartbeat);
    await terminateContainer(containerName(task.id,task.leaseToken));
    if(root)await rm(root,{recursive:true,force:true});
    await refreshPipeline(task.pipelineId);
  }
}
export async function runOnce() {
  const task=await claimTask();
  if(!task)return false;
  await executeTask(task);
  return true;
}

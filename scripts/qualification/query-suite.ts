/**
 * Query benchmark on actual persisted native content and history, never a
 * fabricated DAG/metadata-only sample. Supports the linked small lifecycle
 * and resumable million-revision file fixture.
 */
import { performance } from "node:perf_hooks";
import { randomBytes } from "node:crypto";
import { readFile,writeFile,mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { db } from "../../src/lib/prisma";
import { tokenHash } from "../../src/lib/auth";
import { runAuthorizedQuery, treeQuery, fileHistory, blameQuery, ancestryQuery,
  compareQuery, diffQuery } from "../../src/source-control/query";

const val=(key:string,def?:string)=>process.argv.find(x=>x.startsWith("--"+key+"="))?.slice(key.length+3)??def;
const input=val("input"),out=val("output"),checkpoint=val("checkpoint");
const samples=Number(val("samples","30"));
if(!input||!out||!Number.isSafeInteger(samples)||samples<1||samples>1000)
  throw Error("Require --input, --output, --samples=1..1000");
const data=JSON.parse(await readFile(input,"utf8"));
const repositoryId=data.repositoryId as string;
if(!repositoryId)throw Error("Missing source repository");
let revision:string,root:string,path:string;
if(checkpoint){
  const saved=JSON.parse(await readFile(checkpoint,"utf8"));
  if(saved.seedPath!==input || !saved.head)throw Error("Checkpoint mismatches input seed");
  revision=saved.head;root=revision;path="scale/active.txt";
}else if(data.input?.changesetCount && data.integrity?.persistedAfterIndependentPhase){
  const ref=await db.sourceReference.findUniqueOrThrow({where:{
    repositoryId_name:{repositoryId,name:"branches/perf"}}});
  revision=ref.changesetId;
  const parent=await db.sourceChangesetParent.findFirst({
    where:{changesetId:revision,position:0},select:{parentId:true}});
  root=parent?.parentId??revision;
  path="base.txt";
}else{
  if(data.status!=="PASSED")throw Error("Linked lifecycle did not finish");
  revision=data.linked?.resultId;
  root=data.stages?.find((x:{stage:string})=>x.stage==="publication")?.data?.root;
  path="src/feature.js";
  if(!revision||!root)throw Error("Missing linked authoritative revision evidence");
}
const repo=await db.repository.findUniqueOrThrow({where:{id:repositoryId},select:{ownerId:true}});
const user=repo.ownerId;
const session=await db.humanSession.create({data:{userId:user,
  tokenHash:tokenHash(randomBytes(32).toString("hex")),
  expiresAt:new Date(Date.now()+3600_000)}});
const actor={type:"HUMAN" as const,id:user,sessionId:session.id};
const operations=[
  ["directory",()=>treeQuery(repositoryId,revision,"",100)],
  ["history",()=>fileHistory(repositoryId,revision,path,true,100)],
  ["blame",()=>blameQuery(repositoryId,revision,path,500,0,100)],
  ["ancestry",()=>ancestryQuery(repositoryId,revision,undefined,100)],
  ["compare",()=>compareQuery(repositoryId,root,revision)],
  ["diff",()=>diffQuery(repositoryId,root,revision,20)],
] as const;
const results=[];
const allStarted=performance.now();
try{
  for(const [name,action] of operations){
    const timings:number[]=[],errors:string[]=[];
    const started=performance.now();
    for(let i=0;i<samples;i++){
      const tick=performance.now();
      try {
        const value=await runAuthorizedQuery(actor,repositoryId,async()=>action());
        if(value===null || value===undefined)throw Error("No query response");
        timings.push(performance.now()-tick);
      }catch(error){
        errors.push(error instanceof Error?error.message:String(error));
        break;
      }
    }
    const sorted=timings.sort((a,b)=>a-b);
    const q=(v:number)=>sorted[Math.max(0,Math.ceil(v*sorted.length)-1)]??null;
    results.push({name,attempted:timings.length+errors.length,completed:timings.length,
      errors,elapsedMs:performance.now()-started,p50Ms:q(.5),p95Ms:q(.95),p99Ms:q(.99)});
    if(errors.length)break;
  }
  const status=results.length===operations.length&&results.every(x=>x.completed===samples)?"PASSED":"FAILED";
  const report={schemaVersion:1,kind:"real-native-query-measurements",status,repositoryId,
    revision,root,path,samplesRequested:samples,results,elapsedMs:performance.now()-allStarted,
    note:"Real authorization, PostgreSQL and object bytes. Query times are measured on this deployment."};
  await mkdir(dirname(out),{recursive:true});
  await writeFile(out,JSON.stringify(report,null,2)+"\n");
  console.log(JSON.stringify({status,repositoryId,results}));
  if(status!=="PASSED")process.exitCode=1;
}catch(error){process.exitCode=1;console.error(error);}
finally{await db.$disconnect();}

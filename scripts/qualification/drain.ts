/**
 * Run real database-backed indexing and review worker functions until the
 * selected repository settles. Returns failure, not success, on incomplete
 * progress; no fabricated worker completions.
 */
import { readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { db } from "../../src/lib/prisma";
import { indexBatch } from "../../src/workers/query-indexer";
import { processNextReview } from "../../src/review/source-review";

const readArg=(key:string,defaultValue?:string)=>process.argv.find(x=>x.startsWith("--"+key+"="))?.slice(key.length+3)??defaultValue;
const input=readArg("input"),output=readArg("output");
const seconds=Number(readArg("seconds","120"));
const parallel=Number(readArg("parallel","4"));
if(!input||!output||!Number.isFinite(seconds)||seconds<1||seconds>7200||
    !Number.isInteger(parallel)||parallel<1||parallel>16)
  throw Error("Require --input --output --seconds=1..7200 --parallel=1..16");
const fixture=JSON.parse(await readFile(input,"utf8"));
if(!fixture.repositoryId)throw Error("Unidentified test repository");
const repositoryId=fixture.repositoryId;
const started=performance.now();
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
let loops=0,thrown=0,reviewClaims=0,indexCompleted=0;
let status="INCOMPLETE",error:string|null=null;
const snapshot=async()=>{
  const [published,indices,reviews]=await Promise.all([
    db.sourceChangeset.count({where:{repositoryId}}),
    db.sourceQueryIndexJob.groupBy({by:["state"],where:{repositoryId},_count:{_all:true}}),
    db.sourceReview.groupBy({by:["state"],where:{repositoryId},_count:{_all:true}}),
  ]);
  const counts=(rows: Array<{state: string; _count: {_all: number}}>)=>
    Object.fromEntries(rows.map(r=>[r.state,r._count._all]));
  return {published,indices:counts(indices),reviews:counts(reviews)};
};
try{
  let current=await snapshot();
  while(performance.now()-started<seconds*1000){
    loops++;
    const batch=await indexBatch(32);
    indexCompleted+=batch.completed;
    const reviews=await Promise.allSettled(Array.from({length:parallel},()=>processNextReview()));
    for(const result of reviews){
      if(result.status==="rejected"){thrown++;error=String(result.reason).slice(0,400);}
      else if(result.value)reviewClaims++;
    }
    current=await snapshot();
    if(current.published>0&&current.indices.SUCCEEDED===current.published&&
        current.reviews.COMPLETED===current.published){
      status="PASSED";break;
    }
    if(!batch.inspected&&!reviews.some(r=>r.status==="fulfilled"&&r.value))await sleep(250);
  }
  const report={repositoryId,status,secondsElapsed:(performance.now()-started)/1000,
    actualWorkerClaims:{review:reviewClaims,index:indexCompleted},loops,errorsCaught:thrown,
    lastError:error,persisted:current,
    caveat:"Worker function invocations in one process; not a multi-node throughput measurement"};
  await writeFile(output,JSON.stringify(report,null,2)+"\n");
  console.log(JSON.stringify(report));
  if(status!=="PASSED")process.exitCode=1;
}catch(e){
  await writeFile(output,JSON.stringify({repositoryId,status:"FAILED",
    error:e instanceof Error?e.message:String(e)},null,2)+"\n");
  process.exitCode=1;
}finally{await db.$disconnect();}

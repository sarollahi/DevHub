/**
 * Persistent-state evidence collector. Queue admission is NEVER treated as
 * execution, review completion or integration success.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { db } from "../../src/lib/prisma";

const arg = (key:string) => process.argv.find(s=>s.startsWith("--"+key+"="))?.slice(key.length+3);
const input = arg("input"), output = arg("output");
if (!input || !output) throw new Error("Require --input=<lifecycle.json> --output=<evidence.json>");
const source = JSON.parse(await readFile(input,"utf8"));
const repo = source.repositoryId;
if (!repo) throw new Error("Lifecycle did not publish an identifiable repository");
const ms = (start:Date|null,end:Date|null) =>
  start && end && end>=start ? end.getTime()-start.getTime():null;
const numbers=(list:Array<number|null>)=>list.filter((x):x is number=>x!==null).sort((a,b)=>a-b);
const dist=(list:Array<number|null>)=>{
  const x=numbers(list);const p=(q:number)=>x.length?x[Math.max(0,Math.ceil(q*x.length)-1)]:null;
  return {count:x.length,p50Ms:p(.5),p95Ms:p(.95),p99Ms:p(.99)};
};
try {
  const [publications,indexJobs,reviews,validations,integrations,refs,approvals,blobGrants] =
    await Promise.all([
      db.sourceChangeset.count({where:{repositoryId:repo}}),
      db.sourceQueryIndexJob.findMany({where:{repositoryId:repo},
        select:{state:true,createdAt:true,indexedAt:true,attempts:true}}),
      db.sourceReview.findMany({where:{repositoryId:repo},
        select:{state:true,createdAt:true,completedAt:true,latencyMs:true,costMicros:true,
          relatedTruncated:true,attempts:true}}),
      db.validationPipeline.findMany({where:{repositoryId:repo},
        select:{state:true,createdAt:true,finishedAt:true,tasks:{select:{
          state:true,startedAt:true,finishedAt:true,attempt:true,signature:true,
          measuredCpuNanos:true,sampledMemoryPeakBytes:true,
          containerNetworkRxBytes:true,containerNetworkTxBytes:true}}}}),
      db.changeIntegration.findMany({where:{repositoryId:repo},
        select:{state:true,createdAt:true,completedAt:true,attempts:true,resultChangesetId:true,
          targetRef:true,lastError:true}}),
      db.sourceReference.findMany({where:{repositoryId:repo},
        select:{name:true,changesetId:true,generation:true,deletedAt:true}}),
      db.sourceChangeApproval.count({where:{changeset:{repositoryId:repo},decision:"APPROVED"}}),
      db.sourceObjectGrant.count({where:{repositoryId:repo}}),
    ]);
  const counts=(items:Array<{state:string}>)=>
    Object.fromEntries([...new Set(items.map(x=>x.state))].sort().map(state=>[
      state,items.filter(x=>x.state===state).length]));
  const tasks=validations.flatMap(v=>v.tasks);
  const taskDone=tasks.filter(t=>t.state==="PASSED" && !!t.signature).length;
  const validationDone=validations.filter(v=>v.state==="PASSED" &&
    v.tasks.length>0 && v.tasks.every(t=>t.state==="PASSED" && !!t.signature)).length;
  const integrated=integrations.filter(i=>i.state==="INTEGRATED" && !!i.resultChangesetId);
  const connected=integrated.every(i=>refs.some(r=>r.name===i.targetRef &&
    r.generation>=2 && !r.deletedAt));
  const data={
    kind:"durable-native-qualification-evidence",repositoryId:repo,observedAt:new Date().toISOString(),
    publication:{persisted:publications,expected:source.input?.changesetCount+1,
      realObjectGrants:blobGrants},
    indexing:{states:counts(indexJobs),latency:dist(indexJobs.map(x=>ms(x.createdAt,x.indexedAt))),
      retryAttempts:indexJobs.reduce((n,x)=>n+Math.max(0,x.attempts-1),0)},
    review:{states:counts(reviews),latency:dist(reviews.map(x=>x.latencyMs)),
      endToEndLatency:dist(reviews.map(x=>ms(x.createdAt,x.completedAt))),
      costMicros:reviews.reduce((s,x)=>s+x.costMicros,0n).toString(),
      truncatedCount:reviews.filter(x=>x.relatedTruncated).length},
    validation:{states:counts(validations),tasks:counts(tasks),signedTasksPassed:taskDone,
      verifiedCompletedPipelines:validationDone,
      queueWait:dist(tasks.map(t=>ms(validations.find(v=>v.tasks.includes(t))?.createdAt??null,t.startedAt))),
      execution:dist(tasks.map(t=>ms(t.startedAt,t.finishedAt))),
      measuredCpuNanos:tasks.reduce((sum,t)=>sum+(t.measuredCpuNanos??0n),0n).toString(),
      missingResourceMeasurements:tasks.filter(t=>t.state==="PASSED" && t.measuredCpuNanos==null).length},
    integration:{states:counts(integrations),completedWithResult:integrated.length,
      endToEnd:dist(integrations.map(x=>ms(x.createdAt,x.completedAt))),
      retries:integrations.reduce((sum,x)=>sum+Math.max(0,x.attempts-1),0),
      integratedTargetsPresent:connected},
    approval:{humanApprovedDecisions:approvals},
    references:refs.map(r=>({name:r.name,generation:r.generation,
      targetChangesetId:r.changesetId,deleted:!!r.deletedAt})),
    stages:{
      "publication":publications===source.input?.changesetCount+1?"PASSED":"FAILED",
      "indexing":indexJobs.length>=publications && indexJobs.every(x=>x.state==="SUCCEEDED")?"PASSED":"NOT_MEASURED",
      "review-completed":reviews.length>=publications && reviews.every(x=>x.state==="COMPLETED")?"PASSED":"NOT_MEASURED",
      "validation-executed":validationDone>0?"PASSED":"NOT_MEASURED",
      "approval":approvals>0?"PASSED":"NOT_MEASURED",
      "integration-completed":integrated.length>0&&connected?"PASSED":"NOT_MEASURED",
      "atomic-ref":source.integrity?.refCasWinners===1&&
        source.integrity?.refCasStaleRejected===source.input?.refWriters-1?"PASSED":"NOT_MEASURED",
      // Neither local workspace fixtures nor inline BLOB grants demonstrate
      // S3 ingress/egress or a native client synchronization round trip.
      "object-storage":"NOT_MEASURED","client-sync":"NOT_MEASURED"
    },
    missingEvidence:["signed validation artifact and actual runner execution for every required job",
      "distributed API/client round trip", "native sparse checkout and hydration",
      "S3 transfer counters and physical object verification",
      "review retrieval quality against labeled ground truth",
      "live regional cache metrics and fault-recovery assertions"],
  };
  await mkdir(dirname(output),{recursive:true});
  await writeFile(output,JSON.stringify(data,null,2)+"\n");
  process.stdout.write(JSON.stringify({repositoryId:repo,stages:data.stages})+"\n");
} catch(error) { console.error(error);process.exitCode=1; }
finally {await db.$disconnect();}

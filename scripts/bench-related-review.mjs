// Synthetic, deterministic inverted-index microbenchmark; no PostgreSQL claims.
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
const sha=x=>createHash("sha256").update(String(x)).digest("hex");
const arg=process.argv.find(x=>x.startsWith("--sizes="));
const sizes=(arg?arg.slice(8):"1000,10000,100000").split(",").map(Number)
  .filter(x=>Number.isSafeInteger(x)&&x>=1000&&x<=100000);
function percentile(xs,p){return xs.slice().sort((a,b)=>a-b)[Math.min(xs.length-1,Math.floor(xs.length*p))]??0;}
function measure(count){
  const start=performance.now(),index=new Map(),records=[];
  const append=(kind,key,i)=>{
    const name=kind+":"+key;
    let list=index.get(name);if(!list){list=[];index.set(name,list);}
    list.push(i);
  };
  for(let i=0;i<count;i++){
    const row={fingerprint:i===count-1?sha("sha:0"):sha("sha:"+i),
      effect:i===count-2?sha("effect:1"):sha("effect:"+i),
      path:"src/"+(i%300)+"/file"+(i%89)+".ts",
      issue:"WORK-"+(i%1000),base:i%100,start:i%500};
    records.push(row);
    append("EXACT",row.fingerprint,i);append("EQUIVALENT",row.effect,i);
    append("PATH",row.path,i);append("ISSUE",row.issue,i);
  }
  const indexMs=performance.now()-start;
  const samples=[count-1,count-2,0,1,...Array.from({length:128},(_,i)=>Math.floor(i*count/128))];
  const latencies=[],queryResults=new Map();
  for(const id of samples){
    const row=records[id],t=performance.now(),found=new Set();
    for(const kind of ["EXACT","EQUIVALENT","PATH","ISSUE"]){
      const key=kind==="EXACT"?row.fingerprint:kind==="EQUIVALENT"?row.effect:
        kind==="PATH"?row.path:row.issue;
      for(const item of index.get(kind+":"+key)??[])if(item!==id)found.add(item);
    }
    latencies.push(performance.now()-t);queryResults.set(id,found);
  }
  // Explicitly labeled, far-separated fixture pairs. Precision is computed
  // only on this labeled fixture set, not as a production claim.
  const expected=[{a:count-1,b:0,kind:"EXACT"},{a:count-2,b:1,kind:"EQUIVALENT"}];
  const recalled=expected.filter(x=>queryResults.get(x.a)?.has(x.b)).length;
  const negative={a:count-1,b:Math.floor(count/2)};
  const falsePositive=records[negative.a].fingerprint===records[negative.b].fingerprint;
  const bytes=[...index].reduce((sum,[key,ids])=>sum+Buffer.byteLength(key)+ids.length*4,0);
  const metrics={dataset:count,fixtureType:"synthetic",indexBuildMs:+indexMs.toFixed(2),
    syntheticIndexEntriesPerSecond:Math.round(count*4/(indexMs/1000)),
    queryMs:{p50:+percentile(latencies,.5).toFixed(4),p95:+percentile(latencies,.95).toFixed(4),
      p99:+percentile(latencies,.99).toFixed(4)},
    labeledFixtureRecall:recalled/expected.length,
    labeledFixturePrecision:recalled/(recalled+Number(falsePositive)),
    indexEntries:count*4,estimatedIndexBytes:bytes,indexedAtFreshness:"immediate-in-memory",
    databaseWorkerThroughput:null,actualDatabaseStorageBytes:null,modelCostUSD:null};
  return metrics;
}
for(const size of sizes)console.log(JSON.stringify(measure(size)));

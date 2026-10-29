/**
 * Measure genuinely deployed node and regional cache instances with verified
 * immutable blobs. Cold designation requires empty per-instance cache state,
 * not merely a freshly started client. Warm data is independently observed.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";

const option=(key:string)=>process.argv.find(s=>s.startsWith("--"+key+"="))?.slice(key.length+3);
const input=option("input"),output=option("output");
const manifest=process.env.DEVHUB_QUALIFICATION_CACHE_TARGETS_FILE;
if(process.env.DEVHUB_QUALIFICATION_ISOLATED!=="YES"||!input||!output||!manifest)
  throw Error("Isolated real-cache run requires linked --input, --output, and a cache endpoint manifest");
const linked=JSON.parse(await readFile(input,"utf8"));
if(linked.status!=="PASSED"||!linked.repositoryId)throw Error("Only completed, verified native content may be used");
const sync=linked.stages.find((x:{stage:string})=>x.stage==="verified-client-sync")?.data;
const objects=sync?.objects;
if(!Array.isArray(objects)||!objects.length)throw Error("Missing verified client object IDs");
const targets=JSON.parse(await readFile(manifest,"utf8"));
if(!Array.isArray(targets)||targets.length<3||!targets.some(x=>x.tier==="regional")||
   targets.filter(x=>x.tier==="node").length<2||
   new Set(targets.map(x=>x.name)).size!==targets.length)
  throw Error("Need distinct named >=2 node and >=1 regional deployed cache endpoints");
const hash=bytes=>createHash("sha256").update("BLOB\0").update(bytes).digest("hex");
const results=[];
for(const target of targets){
  const url=new URL(target.url);
  if(!["https:","http:"].includes(url.protocol) || url.username||url.password||url.search ||
     (url.protocol!=="https:"&&!["127.0.0.1","localhost"].includes(url.hostname)))
    throw Error("Untrusted or credential-bearing cache URL");
  const token=process.env[target.tokenEnv??"DEVHUB_CACHE_TEST_TOKEN"];
  if(!token || token.length<24)throw Error("Cache credentials missing for "+target.name);
  const headers={authorization:"Bearer "+token};
  const request=async(path)=>{
    const response=await fetch(url.origin+path,{headers,redirect:"error",
      signal:AbortSignal.timeout(20000)});
    if(!response.ok)throw Error(target.name+" returned "+response.status+" for "+path);
    return response;
  };
  const status=async()=>await (await request("/v1/status")).json();
  const before=await status();
  if(before.entries!==0)throw Error("Not a cold cache: "+target.name+" has "+before.entries+" persisted entries");
  const phases=[];
  for(const phase of ["cold","warm"]){
    const prev=await status();
    const samples=[],start=performance.now();let bytes=0;
    for(const item of objects){
      const began=performance.now();
      const response=await request("/v1/objects/"+linked.repositoryId+"/"+item.id);
      const content=Buffer.from(await response.arrayBuffer());
      if(hash(content)!==item.id)throw Error("Cache object integrity failure at "+target.name);
      samples.push(performance.now()-began);bytes+=content.length;
    }
    const next=await status();
    const sorted=samples.sort((a,b)=>a-b);
    const p=q=>sorted[Math.max(0,Math.ceil(q*sorted.length)-1)]??null;
    const hits=next.hits-prev.hits,misses=next.misses-prev.misses;
    const record={phase,count:samples.length,verifiedBytes:bytes,
      durationMs:performance.now()-start,
      p50Ms:p(.50),p95Ms:p(.95),p99Ms:p(.99),
      hits,misses,hitRate:hits+misses?hits/(hits+misses):null,
      originRequests:next.upstreamRequests-prev.upstreamRequests,
      regionalRequests:next.regionalRequests-prev.regionalRequests,
      coalesced:next.coalesced-prev.coalesced,
      integrityFailures:next.integrityFailures-prev.integrityFailures};
    if(record.integrityFailures!==0 ||
       (phase==="cold"&&record.misses!==objects.length)||
       (phase==="warm"&&record.hits!==objects.length))
      throw Error("Cache stage fails measured cold/warm integrity or cache miss/hit assertion");
    phases.push(record);
  }
  results.push({name:target.name,tier:target.tier,origin:url.origin,initialEntries:before.entries,phases});
}
const report={schemaVersion:1,kind:"real-distributed-cache-qualification",
  measuredAt:new Date().toISOString(),repositoryId:linked.repositoryId,
  objectCount:objects.length,results,
  stages:{"cache-cold":"PASSED","cache-warm":"PASSED"},
  limitations:["These cache instances are observed via direct endpoints; actual physical-node independence requires platform inventory attestation",
    "Test objects may deduplicate by byte content, but all retrieved immutable identities are checked",
    "Failure recovery is measured independently by the controlled fault drill"]};
await mkdir(dirname(output),{recursive:true});
await writeFile(output,JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify({kind:report.kind,status:"PASSED",
  endpoints:results.length,verifiedObjectCount:objects.length}));

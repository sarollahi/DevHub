/**
 * Observed infrastructure and per-repository cost evidence. Never converts an
 * unmeasured dimension to zero. Scrapes real endpoints and PostgreSQL primary.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { hostname, cpus, totalmem } from "node:os";
import { db } from "../../src/lib/prisma";

const args=Object.fromEntries(process.argv.slice(2).filter(x=>x.startsWith("--")&&x.includes("="))
  .map(x=>{const [k,...rest]=x.slice(2).split("=");return [k,rest.join("=")]}));
if(!args.input || !args.output)throw Error("Require --input=<fixture JSON> --output=<metric JSON>");
const source=JSON.parse(await readFile(args.input,"utf8"));
const repositoryId=source.repositoryId as string;
if(!repositoryId || !/^[a-f0-9-]{36}$/i.test(repositoryId))
  throw Error("Unrecognized repository ID in fixture");
const nullableSum=(values:Array<bigint|null>)=>{
  const measured=values.filter((v):v is bigint=>v!==null);
  return {knownTotal:measured.reduce((a,b)=>a+b,0n).toString(),
    observedCount:measured.length,missingCount:values.length-measured.length,
    complete:measured.length===values.length};
};
const snapshot=async()=>{
  const [repositories,taskRows,reviewRows,objectTransfers,usage,postgres,wal]=await Promise.all([
    db.repository.findUniqueOrThrow({where:{id:repositoryId},select:{
      id:true,organizationId:true,ownerId:true,storedBytes:true}}),
    db.validationTask.findMany({where:{pipeline:{repositoryId}},select:{
      state:true,attempt:true,measuredCpuNanos:true,sampledMemoryPeakBytes:true,
      containerNetworkRxBytes:true,containerNetworkTxBytes:true,
      startedAt:true,finishedAt:true}}),
    db.sourceReview.findMany({where:{repositoryId},select:{
      costMicros:true,latencyMs:true,startedAt:true,completedAt:true,provider:true}}),
    db.blobTransfer.findMany({where:{repositoryId},select:{
      state:true,rawInputBytes:true,encodedPutBytes:true,
      encodedGetBytes:true,rawOutputBytes:true}}),
    db.sourceChangeset.count({where:{repositoryId}}),
    db.$queryRaw<Array<Record<string,unknown>>>`
      SELECT numbackends, xact_commit, xact_rollback,
        blks_read, blks_hit, tup_returned, tup_fetched, tup_inserted,
        tup_updated, tup_deleted, temp_bytes, deadlocks
      FROM pg_stat_database WHERE datname = current_database()`
      .catch(error=>[{error:String(error)}]),
    db.$queryRaw<Array<Record<string,unknown>>>`
      SELECT wal_records, wal_fpi, wal_bytes FROM pg_stat_wal`
      .catch(error=>[{error:String(error)}]),
  ]);
  const amount=(records:Array<bigint|null>)=>nullableSum(records);
  return {
    repository:{id:repositories.id,
      tenantId:repositories.organizationId??repositories.ownerId,
      storedBytes:repositories.storedBytes.toString(),changesets:usage},
    validation:{tasks:taskRows.length,
      completedTasks:taskRows.filter(t=>t.state==="PASSED").length,
      cpuNanos:amount(taskRows.map(t=>t.measuredCpuNanos)),
      networkRxBytes:amount(taskRows.map(t=>t.containerNetworkRxBytes)),
      networkTxBytes:amount(taskRows.map(t=>t.containerNetworkTxBytes)),
      peakMemoryBytes:taskRows.map(t=>t.sampledMemoryPeakBytes?.toString()??null),
      executionWallMs:taskRows.map(t=>t.startedAt&&t.finishedAt?
        t.finishedAt.getTime()-t.startedAt.getTime():null)},
    review:{jobs:reviewRows.length,
      recordedCostMicros:reviewRows.reduce((n,x)=>n+x.costMicros,0n).toString(),
      providerBackedCount:reviewRows.filter(x=>!!x.provider).length,
      unpricedCost:reviewRows.some(x=>!x.provider)},
    storage:{transfers:objectTransfers.length,states:objectTransfers.map(t=>t.state),
      rawIngressBytes:amount(objectTransfers.map(x=>x.rawInputBytes)),
      encodedIngressBytes:amount(objectTransfers.map(x=>x.encodedPutBytes)),
      rawEgressBytes:amount(objectTransfers.map(x=>x.rawOutputBytes)),
      encodedEgressBytes:amount(objectTransfers.map(x=>x.encodedGetBytes))},
    postgres:{database:postgres.map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[
      k,typeof v==="bigint"?v.toString():v]))),
      wal:wal.map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[
        k,typeof v==="bigint"?v.toString():v])))},
  };
};
const targets=process.env.DEVHUB_QUALIFICATION_METRIC_TARGETS_FILE?
  JSON.parse(await readFile(process.env.DEVHUB_QUALIFICATION_METRIC_TARGETS_FILE,"utf8")):[];
if(!Array.isArray(targets) || targets.length>100)throw Error("Invalid metrics targets file");
const scraped=[];
for(const target of targets){
  const entry:{name:string;role:string;status:string;metrics?:Record<string,number>;
    error?:string;timestamp:string}={name:String(target.name),role:String(target.role),
    status:"FAILED",timestamp:new Date().toISOString()};
  try{
    const parsed=new URL(String(target.url));
    if(!["http:","https:"].includes(parsed.protocol)||parsed.username||parsed.password||parsed.search)
      throw Error("Credential-bearing metric URL is forbidden");
    if(parsed.protocol!=="https:"&&!["127.0.0.1","localhost"].includes(parsed.hostname))
      throw Error("Nonlocal metric target requires HTTPS");
    const token=process.env[String(target.tokenEnv??"OPS_METRICS_TOKEN")];
    if(!token)throw Error("Metric target token not supplied");
    const response=await fetch(parsed,{headers:{authorization:"Bearer "+token},
      signal:AbortSignal.timeout(5000)});
    if(!response.ok)throw Error("HTTP "+response.status);
    const body=await response.text();
    const values:Record<string,number>={};
    if(target.format==="json"){
      const parsed=JSON.parse(body);
      for(const [key,value] of Object.entries(parsed)) {
        if(typeof value==="number"&&Number.isFinite(value)&&
          /^(hits|misses|upstreamRequests|regionalRequests|bytes|integrityFailures|coalesced|evictions)$/.test(key))
          values[key]=value;
      }
    }else {
      for(const line of body.split("\n")){
        const match=/^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{[^}]*\})?\s+([-+\d.eE]+)(?:\s|$)/.exec(line);
        if(match && /^(devhub_|process_|node_|pg_|redis_)/.test(match[1])){
          const value=Number(match[2]);
          if(Number.isFinite(value)) values[match[1]]=value;
        }
      }
    }
    if(!Object.keys(values).length)throw Error("No supported numeric metrics");
    entry.metrics=values;entry.status="OBSERVED";
  }catch(e){entry.error=e instanceof Error?e.message:String(e);}
  scraped.push(entry);
}
const result={schemaVersion:1,kind:"real-resource-snapshot",timestamp:new Date().toISOString(),
  driver:{host:hostname(),cpus:cpus().length,memoryBytes:totalmem(),
    cpu:process.cpuUsage(),rssBytes:process.memoryUsage().rss},
  ...await snapshot(),targets:scraped,
  missing:[
    ...(scraped.length===0?["multi-node endpoint metrics (none configured)"]:[]),
    "Uninstrumented physical network and S3 provider billing are not inferred",
    "A single process cannot measure all worker CPU/RSS without independently scraped exporters",
    "Single DB counters apply to all tenants, not per-tenant chargeback",
  ]};
await mkdir(dirname(args.output),{recursive:true});
await writeFile(args.output,JSON.stringify(result,null,2)+"\n",{mode:0o600});
console.log(JSON.stringify({kind:result.kind,repositoryId,targetCounts:{
  observed:scraped.filter(x=>x.status==="OBSERVED").length,failed:scraped.filter(x=>x.status!=="OBSERVED").length},
  output:args.output}));
if(scraped.some(x=>x.status!=="OBSERVED"))process.exitCode=1;
await db.$disconnect();

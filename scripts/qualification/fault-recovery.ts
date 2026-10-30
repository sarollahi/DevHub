/**
 * Destructive tests are permitted only for the disposable Compose topology.
 * Records real outages/partitions and validates DB ref integrity and S3
 * content after every restoration. A clean idle outage does not establish
 * in-flight worker crash recovery; that evidence is tracked separately.
 */
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { db } from "../../src/lib/prisma";
import { verifiedBlobStream } from "../../src/object-store/service";

const flags=Object.fromEntries(process.argv.slice(2).filter(x=>x.startsWith("--")&&x.includes("="))
  .map(x=>{const [k,...v]=x.slice(2).split("=");return [k,v.join("=")]}));
if(process.env.DEVHUB_QUALIFICATION_ISOLATED!=="YES" ||
   process.env.DEVHUB_QUALIFICATION_FAULT_ENABLED!=="YES" ||
   process.env.DEVHUB_QUALIFICATION_APPROVAL!=="RUN_FULL_SCALE" ||
   process.env.NODE_ENV==="production" ||
   !process.env.COMPOSE_FILE?.endsWith("/ops/qualification/compose.yml") ||
   !flags.input || !flags.output)throw Error("Fault drills require explicit disposable Compose topology, input and output");
// Prevent a local Compose outage from being credited against an unrelated
// managed/remote database or object-store deployment.
const dbHost=new URL(process.env.DATABASE_URL??"").hostname;
const objectHost=new URL(process.env.OBJECT_STORE_ENDPOINT??"").hostname;
const redisHost=new URL(process.env.REDIS_URL??"").hostname;
const local=(host:string,names:string[])=>names.includes(host);
if(!local(dbHost,["localhost","127.0.0.1","db"]) ||
   !local(objectHost,["localhost","127.0.0.1","minio"]) ||
   !local(redisHost,["localhost","127.0.0.1","redis"]))
  throw Error("Fault drill service URLs must point to the disposable Compose topology");
const input=JSON.parse(await readFile(flags.input,"utf8"));
const repositoryId=input.repositoryId;
if(!repositoryId)throw Error("Missing fixture repository");
const state=async()=>({
  refs:await db.sourceReference.findMany({where:{repositoryId},
    orderBy:{name:"asc"},select:{name:true,changesetId:true,generation:true,deletedAt:true}}),
  changesets:await db.sourceChangeset.count({where:{repositoryId}}),
  objectGrants:await db.sourceObjectGrant.count({where:{repositoryId}}),
});
const baseline=await state();
const results:Array<Record<string,unknown>>=[];
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function run(name:string,script:string,service:string){
  const path=flags.output+"."+name+"-"+service+".json";
  const args=["--import","tsx",script,"--service="+service,"--seconds=3","--output="+path];
  const started=performance.now();
  let error:string|null=null,code:number|null=null;
  const env={...process.env,DEVHUB_FAULT_DRILL:"isolated-local-only"};
  const child=spawn(process.execPath,args,{stdio:["ignore","pipe","pipe"],env});
  let stderr="";
  child.stderr.on("data",chunk=>{stderr=(stderr+String(chunk)).slice(-2000);});
  child.stdout.resume();
  const end=await new Promise<{code:number|null;error?:string}>(resolve=>{
    child.once("error",e=>resolve({code:null,error:String(e)}));
    child.once("close",c=>resolve({code:c}));
  });
  error=end.error??null;code=end.code;
  let evidence:Record<string,unknown>|null=null;
  try{evidence=JSON.parse(await readFile(path,"utf8"));}catch(e){error="Missing generated fault evidence: "+String(e);}
  let restored=false,integrity=false,verifiedObjects=0;
  const deadline=performance.now()+45000;
  while(performance.now()<deadline){
    try{
      const after=await state();
      integrity=JSON.stringify(after)===JSON.stringify(baseline);
      if(!integrity)throw Error("Refs, generations or immutable object counts changed");
      const objects=await db.sourceObject.findMany({where:{
        grants:{some:{repositoryId}},externalId:{not:null}},take:3,
        select:{id:true,externalId:true}});
      for(const object of objects){
        const stored=await db.storedBlob.findUniqueOrThrow({where:{id:object.id}});
        for await(const _part of await verifiedBlobStream(stored)) { /* verifies full hash */ }
      }
      verifiedObjects=objects.length;
      restored=true;break;
    }catch(e){error=String(e);await sleep(1000);}
  }
  const successful=code===0&&restored&&integrity &&
    (name==="partition" ? evidence?.peerUnreachableDuringFault===true &&
      evidence?.peerReachableAfterRestore===true :
      evidence?.restored===true);
  results.push({name,service,exitCode:code,elapsedMs:Math.round(performance.now()-started),
    recovered:restored,integrity,verifiedObjects,success:successful,evidence,error,stderrTail:stderr});
  await writeFile(flags.output,JSON.stringify({schemaVersion:1,repositoryId,
    baseline,results,completed:results.every(r=>r.success)},null,2)+"\n");
  if(!successful)throw Error("Fault/recovery failed: "+name+"/"+service+" "+(error??""));
}
try {
  await mkdir(dirname(flags.output),{recursive:true});
  // The fault driver restores the service before this script returns, even
  // on a check failure. Never run concurrent disruptive faults on one cluster.
  for(const service of ["redis","minio","db"])
    await run("restart","scripts/fault-drill.mjs",service);
  for(const service of ["redis","minio","db"])
    await run("partition","scripts/network-partition.mjs",service);
  console.log(JSON.stringify({repositoryId,verifiedDrills:results.length,
    caveat:"Controlled dependency interruption at idle state, not full in-flight recovery evidence"}));
}catch(e){
  await writeFile(flags.output,JSON.stringify({schemaVersion:1,repositoryId,
    baseline,results,error:e instanceof Error?e.message:String(e)},null,2)+"\n");
  process.exitCode=1;
  console.error(e);
}finally{await db.$disconnect();}

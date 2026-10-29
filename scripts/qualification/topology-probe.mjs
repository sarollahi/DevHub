#!/usr/bin/env node
/**
 * Verify direct API origins, never just an untrusted topology declaration or
 * multiple gateway requests that may reach the same replica.
 * Linux boot fingerprints distinguish separate kernels/hosts; Kubernetes
 * containers on one physical host normally share the same kernel boot ID.
 */
import { readFile,writeFile,mkdir } from "node:fs/promises";
import { dirname } from "node:path";
const arg=(name)=>process.argv.find(x=>x.startsWith("--"+name+"="))?.slice(name.length+3);
const topologyFile=arg("topology"),output=arg("output");
if(process.env.DEVHUB_QUALIFICATION_ISOLATED!=="YES"||
  !topologyFile||!output)throw Error("Require isolated --topology and --output");
const token=process.env.OPS_METRICS_TOKEN;
if(!token||token.length<32)throw Error("Operator-only instance metrics token required");
const topology=JSON.parse(await readFile(topologyFile,"utf8"));
const origins=topology.apiOrigins;
if(topology.isolated!==true||!Array.isArray(origins)||origins.length<2)
  throw Error("Provide at least two direct API replica origins in observed topology");
const responses=[];
for(const entry of origins){
  const location=new URL(typeof entry==="string"?entry:entry.url);
  if(location.username||location.password||location.search||location.pathname!=="/"||
     (location.protocol!=="https:"&&!["localhost","127.0.0.1"].includes(location.hostname)))
    throw Error("Direct remote API origins must be HTTPS and credential-free");
  const origin=location.origin;
  try{
    const response=await fetch(origin+"/api/ops/identity",{
      headers:{authorization:"Bearer "+token},
      redirect:"error",signal:AbortSignal.timeout(7000)});
    if(!response.ok)throw Error("Identity endpoint HTTP "+response.status);
    const value=await response.json();
    if(!/^[a-f0-9]{64}$/.test(value.instanceId??"") ||
       !/^[a-f0-9]{64}$/.test(value.physicalHostFingerprint??""))
      throw Error("Instance identity or physical kernel identity unavailable");
    responses.push({origin,status:"OBSERVED",instanceId:value.instanceId,
      physicalHostFingerprint:value.physicalHostFingerprint,
      declaredNodeId:value.declaredNodeId??null,declaredRegion:value.declaredRegion??null});
  }catch(error){responses.push({origin,status:"FAILED",
    error:error instanceof Error?error.message:String(error)});}
}
const observed=responses.filter(x=>x.status==="OBSERVED");
const uniqueInstances=new Set(observed.map(x=>x.instanceId)).size;
const uniqueKernels=new Set(observed.map(x=>x.physicalHostFingerprint)).size;
const passed=observed.length===origins.length && uniqueInstances>=2&&uniqueKernels>=2;
const report={schemaVersion:1,kind:"observed-api-replica-topology",status:passed?"PASSED":"FAILED",
  measuredAt:new Date().toISOString(),requested:origins.length,
  uniqueInstances,uniquePhysicalKernels:uniqueKernels,instances:responses,
  limitations:["Physical kernel fingerprints provide host-level separation, not region-zone cloud-provider attestation",
    "Additional per-worker and per-cache topology still require their own identity evidence"]};
await mkdir(dirname(output),{recursive:true});
await writeFile(output,JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify({kind:report.kind,status:report.status,
  uniqueInstances,uniquePhysicalKernels,report:output}));
if(!passed)process.exitCode=1;

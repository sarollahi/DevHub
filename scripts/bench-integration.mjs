import { performance } from "node:perf_hooks";
import { planIntegration } from "../src/integration/plan.ts";

const value=(name,fallback)=>{const flag=process.argv.find(a=>a.startsWith("--"+name+"="));return flag?Number(flag.split("=")[1]):fallback;};
const count=Math.max(1000,Math.min(250000,value("count",12000)));
const clients=Math.max(1,Math.min(64,value("workers",16)));
const paths=Math.max(4,Math.min(500,value("paths",80)));
const hash=n=>n.toString(16).padStart(64,"0");
const base=Array.from({length:paths},(_,i)=>({path:"src/file-"+i+".ts",objectId:hash(i+1),mode:"100644"}));
const make=(i)=>{
 const left=base.map(x=>x.path==="src/file-"+(i%paths)+".ts"?{...x,objectId:hash(500000+i)}:x);
 const right=base.map(x=>x.path==="src/file-"+((i+1)%paths)+".ts"?{...x,objectId:hash(700000+i)}:x);
 return {left,right};
};
const durations=[];
let conflicts=0,wrong=0,processed=0,peakRss=process.memoryUsage().rss;
const start=performance.now();
await Promise.all(Array.from({length:clients},async(_,n)=>{
 for(let i=n;i<count;i+=clients){
  const {left,right}=make(i);
  const at=performance.now();
  const outcome=planIntegration(base,left,right);
  durations.push(performance.now()-at);
  if(outcome.conflicts.length)conflicts++;
  if(outcome.operations.length!==1)wrong++;
  processed++;
  if((i%2000)===0){peakRss=Math.max(peakRss,process.memoryUsage().rss);await Promise.resolve();}
 }
}));
durations.sort((a,b)=>a-b);
const elapsed=(performance.now()-start)/1000;
const p=(ratio)=>Number((durations[Math.min(durations.length-1,Math.floor(ratio*durations.length))]??0).toFixed(3));
const result={workload:"immutable-three-way-tree-preparation",samples:processed,simulatedWorkers:clients,pathsPerTree:paths,
 seconds:Number(elapsed.toFixed(3)),preparationsPerSecond:Math.round(processed/elapsed),p50Ms:p(.5),p95Ms:p(.95),
 p99Ms:p(.99),peakRssMiB:Math.round(peakRss/1024/1024),conflicts,wrong};
console.log(JSON.stringify(result,null,2));
if(conflicts||wrong||!Number.isFinite(result.preparationsPerSecond))process.exitCode=1;

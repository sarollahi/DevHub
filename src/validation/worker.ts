import { db } from "../lib/prisma";
import { claimTask, executeTask } from "./runner";
import { refreshPipeline } from "./service";
async function main() {
  if (!process.env.VALIDATION_SIGNING_PRIVATE_KEY) throw new Error("Runner signing key missing");
  const parallel=Math.max(1,Math.min(16,Number(process.env.VALIDATION_RUNNER_CONCURRENCY||2)));
  let stopping=false;
  process.on("SIGTERM",()=>{stopping=true;});
  process.on("SIGINT",()=>{stopping=true;});
  async function loop() {
    let lastSweep=0;
    while(!stopping) {
      try {
        if(Date.now()-lastSweep>10000){
          lastSweep=Date.now();
          const expired=await db.$queryRaw<Array<{pipelineId:string}>>`
            UPDATE "ValidationTask"
            SET state='ERRORED', "leaseToken"=NULL, "leaseUntil"=NULL,
                "finishedAt"=now(), summary='Runner lease expired after maximum attempts'
            WHERE state='RUNNING' AND "leaseUntil"<now() AND attempt >= "maxAttempts"
            RETURNING "pipelineId"`;
          for(const id of new Set(expired.map(t=>t.pipelineId)))await refreshPipeline(id);
        }
        const task=await claimTask();
        if(task)await executeTask(task);
        else await new Promise(resolve=>setTimeout(resolve,1000));
      } catch(error) {
        console.error("Validation scheduler error",error);
        await new Promise(resolve=>setTimeout(resolve,2000));
      }
    }
  }
  try {await Promise.all(Array.from({length:parallel},()=>loop()));}
  finally {await db.$disconnect();}
}
if(process.argv[1]?.endsWith("worker.ts"))main().catch(error=>{console.error(error);process.exitCode=1;});

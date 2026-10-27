import { db } from "../lib/prisma";
import { processNextDeployment } from "./service";
async function main(){
 let stopping=false;
 process.on("SIGINT",()=>{stopping=true;});
 process.on("SIGTERM",()=>{stopping=true;});
 while(!stopping){
   try{if(await processNextDeployment())continue;}
   catch(error){console.error("Deployment scheduler error",error);}
   await new Promise(resolve=>setTimeout(resolve,1000));
 }
 await db.$disconnect();
}
if(process.argv[1]?.endsWith("deployment/worker.ts"))
 main().catch(e=>{console.error(e);process.exitCode=1;});

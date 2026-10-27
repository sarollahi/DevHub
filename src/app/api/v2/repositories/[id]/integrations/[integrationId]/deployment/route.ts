import { NextRequest, NextResponse } from "next/server";
import { deploymentGate } from "@/integration/service";
import { requireRepositoryAccess, sourceFailure } from "@/source-control/http";
export const runtime="nodejs";
type Context={params:Promise<{id:string;integrationId:string}>};
async function check(request:NextRequest,context:Context,trigger:boolean){
 try{
  const {id,integrationId}=await context.params;
  const {actor}=await requireRepositoryAccess(request,id,trigger?"validations:run":"changesets:read");
  const result=await deploymentGate(id,integrationId,actor,trigger);
  return NextResponse.json({apiVersion:2,...result});
 }catch(error){return sourceFailure(error);}
}
export async function GET(request:NextRequest,context:Context){return check(request,context,false);}
export async function POST(request:NextRequest,context:Context){return check(request,context,true);}

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/prisma";
import { updateIntegrationPolicy } from "@/integration/service";
import { requireRepositoryAccess, sourceFailure, readBoundedJson } from "@/source-control/http";
export const runtime="nodejs";
const schema=z.object({
 targetRef:z.string().min(1).max(200),
 preChecks:z.boolean(),targetChecks:z.boolean(),postChecks:z.boolean(),
 deploymentChecks:z.boolean(),maxRetries:z.number().int().min(1).max(32),
}).strict();
export async function PUT(request:NextRequest,{params}:{params:Promise<{id:string}>}){
 try{
  const {id}=await params;
  const body=schema.parse(await readBoundedJson(request,4096));
  const {actor}=await requireRepositoryAccess(request,id,"admin",true);
  const {targetRef,...value}=body;
  const record=await updateIntegrationPolicy(id,targetRef,actor,value);
  return NextResponse.json({apiVersion:2,record});
 }catch(error){return sourceFailure(error);}
}
export async function GET(request:NextRequest,{params}:{params:Promise<{id:string}>}){
 try{
  const {id}=await params;
  await requireRepositoryAccess(request,id,"changesets:read");
  return NextResponse.json({apiVersion:2,records:await db.integrationPolicy.findMany({where:{repositoryId:id}})});
 }catch(error){return sourceFailure(error);}
}

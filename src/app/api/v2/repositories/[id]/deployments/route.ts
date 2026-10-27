import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/prisma";
import { enqueueDeployment } from "@/deployment/service";
import { requireRepositoryAccess, sourceFailure, readBoundedJson } from "@/source-control/http";
export const runtime="nodejs";
const input=z.object({integrationId:z.string().uuid(),
 environment:z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/),
 requestKey:z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/)}).strict();
export async function POST(req:NextRequest,{params}:{params:Promise<{id:string}>}){
 try{
  const {id}=await params;
  const {actor}=await requireRepositoryAccess(req,id,"admin",true);
  const body=input.parse(await readBoundedJson(req,2048));
  const record=await enqueueDeployment(id,actor,body);
  return NextResponse.json({apiVersion:2,record},{status:202});
 }catch(error){return sourceFailure(error);}
}
export async function GET(req:NextRequest,{params}:{params:Promise<{id:string}>}){
 try{
  const {id}=await params;await requireRepositoryAccess(req,id,"admin",true);
  const records=await db.deploymentExecution.findMany({where:{repositoryId:id},
    orderBy:{createdAt:"desc"},take:50});
  return NextResponse.json({apiVersion:2,records});
 }catch(error){return sourceFailure(error);}
}

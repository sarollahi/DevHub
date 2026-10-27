import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/prisma";
import { SourceControlError } from "@/source-control/contracts";
import { sourceFailure, readBoundedJson } from "@/source-control/http";
import { receiveReceipt } from "@/deployment/service";
export const runtime="nodejs";
export async function POST(req:NextRequest,{params}:{params:Promise<{deploymentId:string}>}){
 try{
  const {deploymentId}=await params;
  const job=await db.deploymentExecution.findUnique({where:{id:deploymentId}});
  if(!job)throw new SourceControlError(404,"NOT_FOUND","Deployment not found");
  // Exact JSON bytes are signed. The controller is the only allowed actor on this endpoint.
  const payload=await readBoundedJson(req,16384);
  const receipt=await receiveReceipt(job,JSON.stringify(payload),
    req.headers.get("x-devhub-receipt-signature"));
  return NextResponse.json({apiVersion:2,receiptId:receipt.receiptId});
 }catch(error){return sourceFailure(error);}
}

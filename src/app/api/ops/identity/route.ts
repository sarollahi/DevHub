import { createHash, timingSafeEqual } from "node:crypto";
import { hostname } from "node:os";
import { readFile } from "node:fs/promises";
import { NextRequest, NextResponse } from "next/server";

export const runtime="nodejs";
export const dynamic="force-dynamic";
const bornAt=new Date().toISOString();
const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
async function physicalHostFingerprint() {
  try {
    const boot=await readFile("/proc/sys/kernel/random/boot_id","utf8");
    const id=boot.trim();
    return /^[0-9a-f-]{36}$/i.test(id)?hash("devhub-node-boot-v1:"+id):null;
  }catch{return null;}
}
export async function GET(request:NextRequest) {
  const expected=process.env.OPS_METRICS_TOKEN??"";
  const provided=(request.headers.get("authorization")??"").replace(/^Bearer /,"");
  const a=Buffer.from(expected),b=Buffer.from(provided);
  if(a.length<32||a.length!==b.length||!timingSafeEqual(a,b)){
    return NextResponse.json({error:"NOT_FOUND"},{status:404,
      headers:{"cache-control":"no-store"}});
  }
  const fingerprint=await physicalHostFingerprint();
  const nodeId=process.env.DEVHUB_NODE_ID??null;
  const instanceId=hash("devhub-instance-v1:"+hostname()+":"+process.pid+":"+bornAt);
  return NextResponse.json({
    apiVersion:1,instanceId,physicalHostFingerprint:fingerprint,
    declaredNodeId:nodeId,declaredRegion:process.env.DEVHUB_REGION??null,
    uptimeSeconds:process.uptime(),bornAt,
  },{headers:{"cache-control":"private, no-store"}});
}

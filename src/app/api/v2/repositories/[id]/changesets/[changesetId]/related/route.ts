import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/prisma";
import { sourceFailure, requireRepositoryAccess } from "@/source-control/http";
import { SourceControlError } from "@/source-control/contracts";
import { classifyCandidate, configuredSemanticThreshold, REVIEW_INDEX_VERSION, type SignalKind } from "@/review/index-algorithms";
import type { NativeAssessment, Region } from "@/review/analysis";
export const runtime="nodejs";
const idPattern=/^[a-f0-9]{64}$/;
const allowed=["EXACT","EQUIVALENT","CONTENT","PATH","ISSUE","SUBSYSTEM","VECTOR"] as const;
export async function GET(request:NextRequest,{params}:{params:Promise<{id:string;changesetId:string}>}){
  try{
    const {id,changesetId}=await params;
    await requireRepositoryAccess(request,id,"changesets:read");
    if(!idPattern.test(changesetId))throw new SourceControlError(422,"INVALID_ID","Invalid changeset ID");
    const value=request.nextUrl.searchParams.get("kind")??"ALL";
    if(value!=="ALL"&&!allowed.includes(value as typeof allowed[number]))
      throw new SourceControlError(422,"INVALID_KIND","Unknown relationship category");
    const kind=value as "ALL"|SignalKind;
    const cursor=request.nextUrl.searchParams.get("cursor");
    if(cursor&&!idPattern.test(cursor))throw new SourceControlError(422,"INVALID_CURSOR","Invalid cursor");
    const limit=Math.max(1,Math.min(100,Number(request.nextUrl.searchParams.get("limit"))||50));
    const record=await db.sourceReview.findFirst({where:{repositoryId:id,changesetId,state:"COMPLETED"},
      select:{changesetId:true,fingerprint:true,equivalenceHash:true,regions:true,embedding:true,indexedAt:true}});
    if(!record?.indexedAt||!record.fingerprint||!record.equivalenceHash)
      throw new SourceControlError(409,"REVIEW_INDEX_PENDING","Review index not ready");
    const own=await db.sourceReviewSignal.findMany({where:{repositoryId:id,changesetId,
      ...(kind==="ALL"?{}:{kind})},select:{kind:true,key:true}});
    const predicates:Prisma.SourceReviewSignalWhereInput[]=[];
    for(const tag of allowed){
      const keys=own.filter(s=>s.kind===tag).map(s=>s.key);
      if(keys.length)predicates.push({kind:tag,key:{in:keys}});
    }
    if(!predicates.length)return NextResponse.json({apiVersion:2,indexVersion:REVIEW_INDEX_VERSION,
      records:[],nextCursor:null,indexedAt:record.indexedAt,advisory:true});
    const rows=await db.sourceReviewSignal.groupBy({by:["changesetId"],where:{
      repositoryId:id,changesetId:{not:changesetId,...(cursor?{gt:cursor}:{})},OR:predicates,
    },orderBy:{changesetId:"asc"},take:limit+1});
    const page=rows.slice(0,limit).map(r=>r.changesetId);
    const [candidateSignals,candidates]=await Promise.all([
      db.sourceReviewSignal.findMany({where:{repositoryId:id,changesetId:{in:page},OR:predicates},
        select:{changesetId:true,kind:true}}),
      db.sourceReview.findMany({where:{repositoryId:id,changesetId:{in:page},state:"COMPLETED"},
        select:{changesetId:true,fingerprint:true,equivalenceHash:true,regions:true,embedding:true,
          riskTier:true,riskScore:true,changeset:{select:{message:true}}}}),
    ]);
    const vector=(v:Prisma.JsonValue|null)=>Array.isArray(v)&&v.every(x=>typeof x==="number"&&Number.isFinite(x))?v as number[]:[];
    const asRegions=(v:Prisma.JsonValue|null)=>Array.isArray(v)?v as Region[]:[];
    const assessment={fingerprint:record.fingerprint,regions:asRegions(record.regions)} as NativeAssessment;
    const matched=new Map<string,Set<SignalKind>>();
    for(const s of candidateSignals){
      const current=matched.get(s.changesetId)??new Set<SignalKind>();
      current.add(s.kind as SignalKind);matched.set(s.changesetId,current);
    }
    const records=candidates.flatMap(candidate=>{
      const relation=classifyCandidate(assessment,record.equivalenceHash!,{
        changesetId:candidate.changesetId,fingerprint:candidate.fingerprint,
        equivalenceHash:candidate.equivalenceHash,regions:asRegions(candidate.regions),
        embedding:vector(candidate.embedding),signals:matched.get(candidate.changesetId)??new Set(),
      },vector(record.embedding),configuredSemanticThreshold());
      return relation?[{...relation,title:candidate.changeset.message,riskTier:candidate.riskTier,
        riskScore:candidate.riskScore}]:[];
    }).sort((a,b)=>b.score-a.score||a.changesetId.localeCompare(b.changesetId));
    return NextResponse.json({apiVersion:2,indexVersion:REVIEW_INDEX_VERSION,advisory:true,
      indexedAt:record.indexedAt,records,nextCursor:rows.length>limit?page[page.length-1]:null});
  }catch(error){return sourceFailure(error);}
}

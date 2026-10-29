import { Prisma } from "@prisma/client";
import { db } from "../lib/prisma";
import { type NativeAssessment, type Region } from "./analysis";
import { classifyCandidate, vectorBuckets, configuredSemanticThreshold, type Relation, type Signal, type SignalKind, RELATED_PREVIEW_LIMIT } from "./index-algorithms";

const limits: Record<SignalKind, number> = {
  EXACT: 64, EQUIVALENT: 64, CONTENT: 32, PATH: 96,
  ISSUE: 48, SUBSYSTEM: 32, VECTOR: 96,
};
const kinds: SignalKind[] = ["EXACT","EQUIVALENT","PATH","CONTENT","ISSUE","VECTOR","SUBSYSTEM"];
const vector = (value: Prisma.JsonValue | null): number[] =>
  Array.isArray(value) && value.every(x=>typeof x==="number" && Number.isFinite(x)) ? value as number[] : [];
const regions = (value: Prisma.JsonValue | null): Region[] =>
  Array.isArray(value) ? value as Region[] : [];

export async function discoverRelated(input: {
  repositoryId: string; changesetId: string; assessment: NativeAssessment;
  equivalenceHash: string; signals: Signal[]; embedding: number[]; vectorNamespace:string;
}) {
  const hits = new Map<string,Set<SignalKind>>();
  let indexedSignalMatches = 0;
  let truncated = false;
  // Separate indexed lookups prioritize exact identity even in very large
  // same-path histories; never let a high-frequency path consume its budget.
  for (const kind of kinds) {
    const keys = kind==="VECTOR" ? vectorBuckets(input.embedding,input.vectorNamespace,true) :
      input.signals.filter(s=>s.kind===kind).map(s=>s.key);
    if (!keys.length) continue;
    const where = {repositoryId:input.repositoryId,kind,key:{in:keys},
      changesetId:{not:input.changesetId}};
    const [count,rows] = await Promise.all([
      db.sourceReviewSignal.count({where}),
      db.sourceReviewSignal.groupBy({by:["changesetId"],where,
        orderBy:{changesetId:"asc"},take:limits[kind]+1}),
    ]);
    indexedSignalMatches += count;
    if (rows.length > limits[kind] || count > limits[kind]) truncated = true;
    for (const row of rows.slice(0,limits[kind])) {
      const set = hits.get(row.changesetId) ?? new Set<SignalKind>();
      set.add(kind); hits.set(row.changesetId,set);
    }
  }
  // Search changed-line intervals directly. Different bases are deliberately
  // treated as possible conflicts rather than falsely comparing line numbers.
  const clauses = input.assessment.regions.slice(0,128).map(region => ({
    path:region.path,
    OR: region.baseObject ? [
      {baseObject:null},
      {baseObject:{not:region.baseObject}},
      {startLine:{lte:BigInt(region.end)},endLine:{gte:BigInt(region.start)}},
    ] : [{path:region.path}],
  }));
  if (clauses.length) {
    const where = {repositoryId:input.repositoryId,changesetId:{not:input.changesetId},OR:clauses};
    const rows = await db.sourceReviewRegion.findMany({
      where,orderBy:[{changesetId:"asc"},{id:"asc"}],take:97,select:{changesetId:true},
    });
    if(rows.length>96 || input.assessment.regions.length>128) truncated=true;
    for(const row of rows.slice(0,96)){
      const set=hits.get(row.changesetId)??new Set<SignalKind>();
      set.add("PATH"); hits.set(row.changesetId,set);
    }
  }
  if(!hits.size) return {relations:[] as Relation[],candidateCount:indexedSignalMatches,truncated};
  const candidates=await db.sourceReview.findMany({where:{
    repositoryId:input.repositoryId,state:"COMPLETED",changesetId:{in:[...hits.keys()]},
  },select:{changesetId:true,fingerprint:true,equivalenceHash:true,regions:true,embedding:true}});
  const matches=candidates.flatMap(candidate=>{
    const result=classifyCandidate(input.assessment,input.equivalenceHash,{
      changesetId:candidate.changesetId,fingerprint:candidate.fingerprint,
      equivalenceHash:candidate.equivalenceHash,regions:regions(candidate.regions),
      embedding:vector(candidate.embedding),signals:hits.get(candidate.changesetId)??new Set(),
    },input.embedding,configuredSemanticThreshold());
    return result?[result]:[];
  }).sort((a,b)=>b.score-a.score||a.changesetId.localeCompare(b.changesetId));
  return {relations:matches.slice(0,RELATED_PREVIEW_LIMIT),
    candidateCount:indexedSignalMatches,truncated:truncated||matches.length>RELATED_PREVIEW_LIMIT};
}

export async function replaceReviewIndex(tx: Prisma.TransactionClient, input: {
  repositoryId:string;changesetId:string;signals:Signal[];regions:Region[];
}) {
  await tx.sourceReviewSignal.deleteMany({where:{changesetId:input.changesetId}});
  await tx.sourceReviewRegion.deleteMany({where:{changesetId:input.changesetId}});
  if(input.signals.length) await tx.sourceReviewSignal.createMany({data:input.signals.map(s=>({
    repositoryId:input.repositoryId,changesetId:input.changesetId,kind:s.kind,key:s.key,
  }))});
  if(input.regions.length) await tx.sourceReviewRegion.createMany({data:input.regions.map(r=>({
    repositoryId:input.repositoryId,changesetId:input.changesetId,path:r.path,
    startLine:BigInt(r.start),endLine:BigInt(r.end),baseObject:r.baseObject,
  }))});
}

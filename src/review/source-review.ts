import { Prisma } from "@prisma/client";
import { db } from "../lib/prisma";
import { getCanonicalSnapshotForReview } from "../source-control/canonical";
import { verifyAndReadBlob } from "../source-control/git-import-blobs";
import { assessNativeChangeset, type Entry } from "./analysis";
import { equivalenceFingerprint, contentFingerprint, indexSignals, issueKeys } from "./index-algorithms";
import { discoverRelated, replaceReviewIndex } from "./related-index";
import { createEmbeddingProvider } from "./embedding-provider";
import { createReviewProvider } from "./provider";

const maxAttempts = 4;

export async function processReview(changesetId: string, lease: Date, attempt: number) {
  const started = Date.now();
  try {
    const change = await db.sourceChangeset.findUniqueOrThrow({
      where: { id: changesetId }, include: {
        operations: { orderBy: { position: "asc" } },
        parents: { orderBy: { position: "asc" } },
      },
    });
    const parentIds = change.parents.map(p => p.parentId);
    const [base, target] = await Promise.all([
      parentIds[0] ? getCanonicalSnapshotForReview(change.repositoryId, parentIds[0], changesetId, lease) : Promise.resolve({ entries: [] }),
      getCanonicalSnapshotForReview(change.repositoryId, changesetId, changesetId, lease),
    ]);
    const before = new Map<string, Entry>(base.entries.map(e => [e.path, e]));
    const after = new Map<string, Entry>(target.entries.map(e => [e.path, e]));
    const touched = [...new Set(change.operations.flatMap(op => [op.path, ...(op.previousPath ? [op.previousPath] : [])]))];
    const ids = new Set<string>();
    for (const path of touched) {
      const old = before.get(path); const next = after.get(path);
      if (old) ids.add(old.objectId);
      if (next) ids.add(next.objectId);
    }
    const bytes = new Map<string, Uint8Array>();
    // Fetch only objects touched by the changeset. A bounded batch avoids a repository-wide blob load.
    // Capture only a bounded prefix; the storage reader hashes the full streamed object.
    // An oversized object receives conservative whole-file overlap and high-risk review.
    for (const id of ids) {
      bytes.set(id, await verifyAndReadBlob(null, id, 128001));
    }
    if (bytes.size !== ids.size) throw new Error("Review cannot locate all authoritative objects");
    const assessed = assessNativeChangeset({
      parents: parentIds, description: change.message, operations: change.operations,
      before, after, bytes,
    });
    const equivalenceHash=equivalenceFingerprint(change.operations,before,after);
    const contentHash=contentFingerprint(change.operations,after);
    let summary=assessed.summary;
    let findings=assessed.findings;
    let model:string|null=null,provider:string|null=null,confidence:number|null=null;
    let embeddingVector:number[]|null=null;
    let costMicros=0n;
    let vectorNamespace="";
    const modelCalls:Array<{changesetId:string;operation:string;provider:string;model:string;
      tokens:number|null;costMicros:bigint;latencyMs:number;succeeded:boolean;error:string|null;confidence:number|null}>=[];
    const configured=createReviewProvider();
    if(configured){
      const callStarted=Date.now();
      try {
        const result=await configured.analyze("Description: "+change.message+"\\nOperations: "+
          JSON.stringify(change.operations.map(op=>({kind:op.kind,path:op.path,previousPath:op.previousPath})))+
          "\\nDeterministic assessment: "+assessed.summary,assessed.excerpt);
        summary+="\\nModel summary (advisory): "+result.summary;
        findings=[...findings,...result.findings.map(f=>({...f,advisory:true as const}))];
        model=result.model;provider=result.provider;confidence=result.confidence;
        embeddingVector=result.embedding;costMicros+=result.costMicros;
        if(embeddingVector)vectorNamespace=provider+":"+model;
        modelCalls.push({changesetId,operation:"ANALYSIS",provider,model,
          tokens:null,costMicros:result.costMicros,latencyMs:Date.now()-callStarted,
          succeeded:true,error:null,confidence});
      }catch(error){
        const reason=error instanceof Error?error.message:"Unknown model error";
        modelCalls.push({changesetId,operation:"ANALYSIS",provider:"configured",model:"configured",
          tokens:null,costMicros:0n,latencyMs:Date.now()-callStarted,succeeded:false,
          error:reason.slice(0,500),confidence:null});
        summary+="\\nModel unavailable; deterministic findings remain authoritative.";
      }
    }
    // Embeddings are independently configurable; no analysis model is required.
    // When legacy analysis already provided a vector, avoid paying twice.
    const embeddingProvider=createEmbeddingProvider();
    if(embeddingProvider&&!embeddingVector){
      const callStarted=Date.now();
      try {
        const result=await embeddingProvider.embed(change.message+"\\n"+assessed.excerpt.slice(0,12000));
        embeddingVector=result.vector;vectorNamespace=result.provider+":"+result.model;
        costMicros+=result.costMicros;
        modelCalls.push({changesetId,operation:"EMBEDDING",provider:result.provider,model:result.model,
          tokens:result.tokens,costMicros:result.costMicros,latencyMs:Date.now()-callStarted,
          succeeded:true,error:null,confidence:null});
      }catch(error){
        modelCalls.push({changesetId,operation:"EMBEDDING",provider:embeddingProvider.provider,
          model:embeddingProvider.model,tokens:null,costMicros:0n,latencyMs:Date.now()-callStarted,
          succeeded:false,error:(error instanceof Error?error.message:"Unknown embedding error").slice(0,500),confidence:null});
      }
    }
    const signals=indexSignals({assessment:assessed,description:change.message,
      equivalenceHash,contentHash,embedding:embeddingVector,vectorNamespace});
    const matches=await discoverRelated({repositoryId:change.repositoryId,changesetId,
      assessment:assessed,equivalenceHash,signals,embedding:embeddingVector??[]});
    const relations=matches.relations;
    const duplicate=relations.find(r=>r.kind==="DUPLICATE")?.changesetId??null;
    const issue=issueKeys(change.message)[0];
    const groupKey=issue?signals.find(s=>s.kind==="ISSUE")?.key??assessed.groupKey:
      assessed.groupKey;
    const requestedTarget=await db.sourceReviewRequest.findFirst({where:{
      repositoryId:change.repositoryId,changesetId,status:"OPEN",
    },orderBy:{createdAt:"asc"},select:{targetRef:true}});
    const target=requestedTarget?await db.sourceReference.findUnique({where:{
      repositoryId_name:{repositoryId:change.repositoryId,name:requestedTarget.targetRef},
    },select:{changesetId:true,deletedAt:true}}):null;
    const targetRevisionId=target&&!target.deletedAt?target.changesetId:null;
    const elapsed = Date.now() - started;
    await db.$transaction(async tx => {
      const updated = await tx.sourceReview.updateMany({ where: {
        changesetId, state: "RUNNING", attempts: attempt, leaseUntil: lease,
      }, data: {
        state: "COMPLETED", leaseUntil: null, error: null, completedAt: new Date(),
        fingerprint: assessed.fingerprint, paths: assessed.paths,
        regions: assessed.regions as unknown as Prisma.InputJsonValue,
        findings: findings as unknown as Prisma.InputJsonValue,
        related: relations as unknown as Prisma.InputJsonValue,
        summary, groupKey, exactDuplicateOf: duplicate, equivalenceHash,
        candidateCount:matches.candidateCount,relatedTruncated:matches.truncated,
        indexedAt:new Date(),targetRevisionId,
        riskTier: assessed.riskTier, riskScore: assessed.riskScore,
        costMicros, latencyMs: elapsed, confidence, provider, model,
        ...(embeddingVector ? { embedding: embeddingVector as Prisma.InputJsonValue } : {}),
      } });
      if (updated.count !== 1) throw new Error("Review lease expired; ignoring stale model results");
      await replaceReviewIndex(tx,{repositoryId:change.repositoryId,changesetId,signals,regions:assessed.regions});
      if(modelCalls.length)await tx.sourceReviewModelCall.createMany({data:modelCalls});
      await tx.auditEvent.create({ data: { repositoryId: change.repositoryId,
        actorType: "SYSTEM", actorId: "native-review-worker", action: "changeset.review.completed",
        subjectId: changesetId, metadata: {
          exactDuplicateOf: duplicate, relatedCount: relations.length,
          indexedSignalMatches:matches.candidateCount,truncated:matches.truncated,
          deterministicRisk: assessed.riskTier, riskScore: assessed.riskScore,
          provider: provider ?? "disabled", latencyMs: elapsed, costMicros: costMicros.toString(),
        },
      } });
    });
    return { changesetId, state: "COMPLETED" as const, relatedCount: relations.length };
  } catch (error) {
    const message = (error instanceof Error ? error.message : "Unknown review failure").slice(0, 800);
    await db.sourceReview.updateMany({ where: {
      changesetId, state: "RUNNING", attempts: attempt, leaseUntil: lease,
    }, data: {
      state: attempt >= maxAttempts ? "FAILED" : "QUEUED",
      leaseUntil: null, error: message,
      nextAttemptAt: new Date(Date.now() + Math.min(60000, 1000 * 2 ** attempt)),
    } });
    throw error;
  }
}

export async function processNextReview(): Promise<boolean> {
  const now = new Date();
  const next = await db.sourceReview.findFirst({ where: {
    attempts: { lt: maxAttempts },
    OR: [
      { state: "QUEUED", nextAttemptAt: { lte: now } },
      { state: "RUNNING", leaseUntil: { lt: now } },
    ],
  }, orderBy: [{ nextAttemptAt: "asc" }, { changesetId: "asc" }],
  select: { changesetId: true, attempts: true, state: true, leaseUntil: true } });
  if (!next) return false;
  const lease = new Date(Date.now() + 120_000);
  const claimed = await db.sourceReview.updateMany({ where: {
    changesetId: next.changesetId, state: next.state, attempts: next.attempts,
    ...(next.state === "RUNNING" ? { leaseUntil: { lt: now } } : { nextAttemptAt: { lte: now } }),
  }, data: {
    state: "RUNNING", attempts: { increment: 1 },
    leaseUntil: lease, startedAt: new Date(), error: null,
  } });
  if (claimed.count === 0) return true;
  await processReview(next.changesetId, lease, next.attempts + 1);
  return true;
}

async function main() {
  let stopping = false;
  process.on("SIGINT", () => { stopping = true; });
  process.on("SIGTERM", () => { stopping = true; });
  const concurrency = Math.min(16, Math.max(1, Number(process.env.DEVHUB_REVIEW_CONCURRENCY ?? "4") || 4));
  const workers = Array.from({ length: concurrency }, async () => {
    while (!stopping) {
      try {
        if (await processNextReview()) continue;
      } catch (error) { console.error("Review job failed:", error); }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  });
  await Promise.all(workers);
  await db.$disconnect();
}
if (process.argv[1]?.endsWith("source-review.ts")) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}

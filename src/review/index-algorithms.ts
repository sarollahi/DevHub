import { createHash } from "node:crypto";
import type { NativeAssessment, Region, Operation, Entry } from "./analysis";
import { cosineSimilarity, regionOverlap } from "./analysis";

export const REVIEW_INDEX_VERSION = 2;
export const DEFAULT_SEMANTIC_SIMILARITY_THRESHOLD = 0.50;
export function configuredSemanticThreshold(): number {
  const threshold=Number(process.env.DEVHUB_EMBEDDING_MIN_SIMILARITY ?? DEFAULT_SEMANTIC_SIMILARITY_THRESHOLD);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error("Invalid embedding similarity threshold");
  return threshold;
}
export const RELATED_PREVIEW_LIMIT = 48;
export type SignalKind = "EXACT" | "EQUIVALENT" | "CONTENT" | "PATH" | "ISSUE" | "SUBSYSTEM" | "VECTOR";
export type Signal = { kind: SignalKind; key: string };
export type RelatedKind = "DUPLICATE" | "EQUIVALENT" | "REGION" | "FILE" | "SIMILAR" | "ISSUE" | "SUBSYSTEM" | "CONTENT";
export type Relation = { changesetId: string; kind: RelatedKind; score: number };
const hash = (v: unknown) => createHash("sha256").update(typeof v === "string" ? v : JSON.stringify(v)).digest("hex");
const hex = (v: number) => v.toString(16).padStart(3, "0");

/** Normalized work-item labels cannot contain user-controlled SQL or index keys. */
export function issueKeys(message: string): string[] {
  return [...new Set((message.match(/\b[A-Z][A-Z0-9]{1,9}-[0-9]{1,8}\b|#[0-9]{1,10}\b/g) ?? [])
    .map(x => x.toUpperCase()))].slice(0, 16);
}
export function subsystem(path: string): string {
  const pieces = path.split("/");
  return pieces.length < 2 ? "root" : pieces.slice(0, Math.min(2, pieces.length - 1)).join("/");
}
/** Content equality is a discovery hint; without identical bases it is not an exact duplicate. */
export function equivalenceFingerprint(operations: Operation[], before: Map<string, Entry>, after: Map<string, Entry>): string {
  return hash(operations.map(op => [op.kind, op.path, op.previousPath ?? null,
    before.get(op.previousPath || op.path)?.objectId ?? null,
    after.get(op.path)?.objectId ?? null, op.fileMode ?? null]).sort((a,b) => String(a[1]).localeCompare(String(b[1]))));
}
export function contentFingerprint(operations: Operation[], after: Map<string, Entry>): string {
  return hash(operations.map(op => [op.kind, after.get(op.path)?.objectId ?? null]).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
}

/** Sparse deterministic random projections provide durable LSH buckets.
 * This is ANN candidate generation, not a proof of semantic equivalence.
 */
function bits(vector: number[], band: number): number {
  let out = 0;
  for (let bit = 0; bit < 10; bit++) {
    let seed = ((band + 1) * 0x9e3779b1 ^ (bit + 1) * 0x85ebca6b) >>> 0;
    let dot = 0;
    for (let k = 0; k < 48; k++) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      const idx = (seed >>> 0) % vector.length;
      // The sign must use independent seed bits: seed parity is correlated with
      // seed % even_dimensions and creates a severe projection bias.
      dot += ((seed >>> 16) & 1 ? 1 : -1) * vector[idx];
    }
    if (dot >= 0) out |= 1 << bit;
  }
  return out;
}
export function vectorBuckets(vector: number[], namespace: string, probe = false): string[] {
  if (!vector.length || vector.length > 4096 || !vector.every(Number.isFinite) ||
    vector.every(v => v === 0)) return [];
  const prefix = hash([REVIEW_INDEX_VERSION, namespace, vector.length]).slice(0, 16);
  const keys: string[] = [];
  for (let band = 0; band < 8; band++) {
    const bucket = bits(vector, band);
    keys.push(prefix + ":" + band + ":" + hex(bucket));
    if (probe) for (let bit = 0; bit < 10; bit++) keys.push(prefix + ":" + band + ":" + hex(bucket ^ (1 << bit)));
  }
  return keys;
}
export function indexSignals(input: {
  assessment: NativeAssessment; description: string; equivalenceHash: string;
  contentHash: string; embedding?: number[] | null; vectorNamespace?: string;
}): Signal[] {
  const { assessment, description, equivalenceHash, contentHash } = input;
  const found: Signal[] = [
    {kind:"EXACT", key:assessment.fingerprint}, {kind:"EQUIVALENT",key:equivalenceHash},
    {kind:"CONTENT",key:contentHash},
    ...assessment.paths.map(path => ({kind:"PATH" as const,key:hash(path)})),
    ...assessment.paths.map(path => ({kind:"SUBSYSTEM" as const,key:hash(subsystem(path))})),
    ...issueKeys(description).map(issue => ({kind:"ISSUE" as const,key:hash(issue)})),
    ...vectorBuckets(input.embedding ?? [],input.vectorNamespace ?? "",false)
      .map(key => ({kind:"VECTOR" as const,key})),
  ];
  return [...new Map(found.map(s => [s.kind+":"+s.key,s])).values()];
}
export type Candidate = {
  changesetId: string; fingerprint: string | null; equivalenceHash: string | null;
  regions: Region[]; embedding: number[]; signals: Set<SignalKind>;
};
export function classifyCandidate(assessment: NativeAssessment, equivalenceHash: string,
  candidate: Candidate, currentEmbedding: number[] = [], threshold=DEFAULT_SEMANTIC_SIMILARITY_THRESHOLD): Relation | null {
  if (candidate.fingerprint === assessment.fingerprint) return {changesetId:candidate.changesetId,kind:"DUPLICATE",score:1};
  if (candidate.equivalenceHash === equivalenceHash) return {changesetId:candidate.changesetId,kind:"EQUIVALENT",score:.99};
  const overlap = regionOverlap(assessment.regions,candidate.regions);
  if (overlap === "REGION") return {changesetId:candidate.changesetId,kind:"REGION",score:.95};
  if (overlap === "FILE") return {changesetId:candidate.changesetId,kind:"FILE",score:.6};
  const similarity = candidate.signals.has("VECTOR") ? cosineSimilarity(currentEmbedding,candidate.embedding) : 0;
  if (similarity >= threshold) return {changesetId:candidate.changesetId,kind:"SIMILAR",score:similarity};
  for (const [kind,score] of [["ISSUE",.55],["CONTENT",.5],["SUBSYSTEM",.25]] as const) {
    if (candidate.signals.has(kind)) return {changesetId:candidate.changesetId,kind,score};
  }
  return null;
}
/** Model confidence never feeds this ordering or branch authorization. */
export function deterministicPriority(riskScore: number | null, related: Relation[], state: string, approved: boolean): number {
  return (riskScore ?? 0) * 3 + (state==="FAILED" ? 120 : 0) +
    (related.some(r=>r.kind==="REGION") ? 80 : 0) +
    (related.some(r=>r.kind==="DUPLICATE") ? 35 : 0) +
    (approved ? -500 : 0);
}

import { createHash } from "node:crypto";

export type Region = { path: string; start: number; end: number; baseObject: string | null; binary: boolean };
export type Entry = { objectId: string; mode: string };
export type Operation = { kind: string; path: string; previousPath?: string | null; objectId?: string | null; fileMode?: string | null };
export type Finding = { severity: "INFO" | "MEDIUM" | "HIGH" | "CRITICAL"; code: string; message: string; advisory: boolean };
export type NativeAssessment = {
  fingerprint: string; paths: string[]; regions: Region[]; findings: Finding[];
  riskScore: number; riskTier: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  summary: string; groupKey: string; excerpt: string;
};
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const secretPattern = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:api[_-]?key|password|secret|access[_-]?token)\s*[:=]\s*["']?[A-Za-z0-9+/=_-]{16,}/i;

export function changedRegion(before: Uint8Array | undefined, after: Uint8Array | undefined): { start: number; end: number; binary: boolean } {
  const a = before ? Buffer.from(before) : Buffer.alloc(0);
  const b = after ? Buffer.from(after) : Buffer.alloc(0);
  if (a.includes(0) || b.includes(0) || a.length > 128_000 || b.length > 128_000) {
    return { start: 0, end: Number.MAX_SAFE_INTEGER, binary: true };
  }
  const oldLines = a.toString("utf8").split("\n");
  const newLines = b.toString("utf8").split("\n");
  let prefix = 0;
  while (prefix < Math.min(oldLines.length, newLines.length) && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix++;
  // A single conservative interval covers non-contiguous edits without missing overlap.
  return { start: prefix + 1, end: Math.max(prefix + 1, newLines.length - suffix, oldLines.length - suffix), binary: false };
}

export function regionOverlap(a: Region[], b: Region[]): "NONE" | "FILE" | "REGION" {
  let file = false;
  for (const left of a) for (const right of b) {
    if (left.path !== right.path) continue;
    file = true;
    // Different bases are not line-comparable. Conservatively report overlap.
    if (!left.baseObject || !right.baseObject || left.baseObject !== right.baseObject
      || (left.start <= right.end && right.start <= left.end)) return "REGION";
  }
  return file ? "FILE" : "NONE";
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length || a.length > 4096 || !a.every(Number.isFinite) || !b.every(Number.isFinite)) return 0;
  let dot = 0, x = 0, y = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; }
  return x && y ? Math.max(0, Math.min(1, dot / Math.sqrt(x * y))) : 0;
}

export function assessNativeChangeset(input: {
  parents: string[]; description: string; operations: Operation[];
  before: Map<string, Entry>; after: Map<string, Entry>;
  bytes: Map<string, Uint8Array>;
}): NativeAssessment {
  const { parents, description, operations, before, after, bytes } = input;
  const paths = [...new Set(operations.flatMap(op => [op.path, ...(op.previousPath ? [op.previousPath] : [])]))].sort();
  const findings: Finding[] = [];
  let score = 0;
  const note = (severity: Finding["severity"], code: string, message: string, points: number) => {
    findings.push({ severity, code, message, advisory: true }); score = Math.max(score, points);
  };
  if (paths.length >= 20) note("MEDIUM", "BROAD_CHANGE", "Broad change affects at least 20 paths", 35);
  const regions: Region[] = [];
  const excerpt: string[] = [];
  for (const op of operations) {
    const oldPath = op.previousPath || op.path;
    const oldEntry = before.get(oldPath);
    const newEntry = after.get(op.path);
    const oldBytes = oldEntry ? bytes.get(oldEntry.objectId) : undefined;
    const newBytes = newEntry ? bytes.get(newEntry.objectId) : undefined;
    const region = op.kind === "CHMOD" || op.kind === "MOVE" || op.kind === "RENAME" || op.kind === "COPY"
      ? { start: 0, end: Number.MAX_SAFE_INTEGER, binary: false } : changedRegion(oldBytes, newBytes);
    regions.push({ ...region, path: op.path, baseObject: oldEntry?.objectId ?? null });
    if (op.previousPath && op.kind !== "COPY") {
      regions.push({ path: op.previousPath, start: 0, end: Number.MAX_SAFE_INTEGER,
        baseObject: oldEntry?.objectId ?? null, binary: region.binary });
    }
    if (/(^|\/)(auth|permissions|security|secrets|iam)(\/|\.|$)/i.test(op.path)) {
      note("HIGH", "SENSITIVE_PATH", "Access-control or security-sensitive path: " + op.path, 65);
    }
    if (/(^|\/)(\.github\/workflows|infra|terraform|deploy)(\/|\.|$)|\.(tf|sql)$/i.test(op.path)) {
      note("HIGH", "INFRASTRUCTURE", "Deployment, automation or database path: " + op.path, 48);
    }
    if (/((^|\/)package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock)$/i.test(op.path)) {
      note("MEDIUM", "DEPENDENCY", "Dependency manifest: " + op.path, 25);
    }
    if (newBytes && newBytes.length > 128000) {
      note("HIGH", "LARGE_CONTENT_REQUIRES_REVIEW", "Content exceeds bounded automated inspection for " + op.path, 60);
    }
    if (newBytes && newBytes.length) {
      // Analyze captured content; large objects are explicitly flagged for manual review.
      const content = Buffer.from(newBytes).toString("utf8");
      if (secretPattern.test(content)) note("CRITICAL", "POTENTIAL_SECRET", "Potential credential material in " + op.path, 90);
      if (!region.binary && excerpt.join("").length < 14000 && !secretPattern.test(content)) {
        excerpt.push(op.path + ": " + content.slice(0, 1000));
      }
    }
  }
  score = Math.min(100, score + Math.min(20, Math.max(0, operations.length - 10)));
  const riskTier = score >= 80 ? "CRITICAL" : score >= 45 ? "HIGH" : score >= 15 ? "MEDIUM" : "LOW";
  // Parent identity plus before/after object IDs prevents conflating identical text on different bases.
  const identity = paths.map(path => [path, before.get(path) ?? null, after.get(path) ?? null]);
  const fingerprint = digest(JSON.stringify([parents, identity]));
  const directory = paths[0]?.split("/")[0] || "root";
  return {
    fingerprint, paths, regions, findings, riskScore: score, riskTier,
    summary: operations.length + " verified operations across " + paths.length + " paths. " +
      (findings.length ? findings.map(f => f.message).join("; ") : "No deterministic security indicators detected."),
    groupKey: digest(directory).slice(0, 32),
    excerpt: excerpt.join("\n").slice(0, 16000),
  };
}

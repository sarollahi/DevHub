import { createHash } from "node:crypto";

export type Tier = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type ReviewAssessment = { riskScore: number; riskTier: Tier; flags: string[]; fingerprint: string; fileSetHash: string };

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function validPath(path: string): boolean {
  if (path.length === 0 || path.length > 512 || path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

export function assessChange(paths: string[], patch: string): ReviewAssessment {
  const normalizedFiles = [...new Set(paths)].sort();
  if (normalizedFiles.some((name) => !validPath(name))) throw new Error("Invalid file path");
  const normalizedPatch = patch.replace(/\r\n/g, "\n").trim();
  const flags: string[] = [];
  let score = 0;
  for (const file of normalizedFiles) {
    if (/(^|\/)(auth|permissions|security|secrets|iam)(\/|\.|$)/i.test(file)) {
      flags.push(`Sensitive access path: ${file}`); score += 45;
    } else if (/(^|\/)(infra|terraform|deploy|\.github\/workflows)(\/|\.|$)|\.(tf|sql)$/i.test(file)) {
      flags.push(`Infrastructure or database path: ${file}`); score += 30;
    } else if (/^(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|package\.json)$/i.test(file)) {
      flags.push(`Dependency update: ${file}`); score += 12;
    }
  }
  if (normalizedFiles.length > 15) { flags.push("Broad file change"); score += 20; }
  if (normalizedPatch.length > 20000) { flags.push("Large patch"); score += 20; }
  if (/(private key|BEGIN [A-Z ]*PRIVATE KEY|password\s*=|secret\s*=)/i.test(normalizedPatch)) {
    flags.push("Potential secret material"); score += 55;
  }
  score = Math.min(100, score);
  const riskTier: Tier = score >= 75 ? "CRITICAL" : score >= 45 ? "HIGH" : score >= 15 ? "MEDIUM" : "LOW";
  return {
    riskScore: score, riskTier, flags,
    fingerprint: sha256(normalizedFiles.join("\n") + "\0" + normalizedPatch),
    fileSetHash: sha256(normalizedFiles.join("\n")),
  };
}

export function canApprove(state: string, checkStates: string[], isHuman: boolean): boolean {
  return isHuman && state === "REVIEW_REQUIRED" && checkStates.length > 0 && checkStates.every((value) => value === "SUCCESS");
}

export function canMerge(state: string, checks: string[], humanApprovalCount: number, targetShaMatches: boolean): boolean {
  return state === "APPROVED" && checks.length > 0 && checks.every((c) => c === "SUCCESS") && humanApprovalCount > 0 && targetShaMatches;
}

export function retryDelayMs(attempt: number): number {
  return Math.min(60_000, 1000 * Math.pow(2, Math.max(0, Math.min(attempt, 10))));
}

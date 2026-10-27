import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import type { ValidationKind, ValidationTask } from "@prisma/client";

export const KINDS = ["COMPILE", "TEST", "LINT", "SECURITY", "SECRETS", "DEPENDENCIES"] as const;
export const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export type Recipe = { kind: ValidationKind; image: string; command: string; timeoutSeconds: number };
const imagePattern = new RegExp("^[a-zA-Z0-9._/:-]+@sha256:[0-9a-f]{64}$");
export function recipes(env: NodeJS.ProcessEnv = process.env): Recipe[] {
  const image = (key: string) => {
    const value = env[key];
    if (!value || !imagePattern.test(value)) throw new Error(key + " must identify a preloaded OCI image by immutable sha256 digest");
    return value;
  };
  const node = image("VALIDATION_NODE_IMAGE");
  const scanner = image("VALIDATION_SCAN_IMAGE");
  const secrets = image("VALIDATION_SECRETS_IMAGE");
  // All executable recipes are controlled by the service. Repository scripts are untrusted
  // and are executed only by the disposable container runner, never by the API process.
  const install = "cp -a /source/. /work/ && cd /work && npm ci --offline --ignore-scripts --no-audit --no-fund";
  return [
    { kind: "COMPILE", image: node, command: install + " && npm run build", timeoutSeconds: 900 },
    { kind: "TEST", image: node, command: install + " && npm test", timeoutSeconds: 900 },
    { kind: "LINT", image: node, command: install + " && npm run lint", timeoutSeconds: 450 },
    { kind: "SECURITY", image: scanner, command: "trivy fs --offline-scan --scanners misconfig --exit-code 1 /source", timeoutSeconds: 360 },
    { kind: "SECRETS", image: secrets, command: "gitleaks dir --no-banner --redact --exit-code 1 /source", timeoutSeconds: 240 },
    { kind: "DEPENDENCIES", image: scanner, command: "trivy fs --offline-scan --scanners vuln --exit-code 1 /source", timeoutSeconds: 360 },
  ];
}
export function configurationDigest(input: Recipe[]): string {
  return digest(JSON.stringify(input));
}
export function fingerprint(repositoryId: string, changesetId: string, target: string | null,
  snapshotDigest: string, dependencyDigest: string, recipe: Recipe): string {
  return digest(JSON.stringify([2, repositoryId, changesetId, target, snapshotDigest,
    dependencyDigest, recipe.kind, recipe.image, recipe.command, recipe.timeoutSeconds]));
}
type SignedTask = Pick<ValidationTask, "id" | "pipelineId" | "kind" | "fingerprint" | "image" |
 "command" | "timeoutSeconds" | "attempt" | "state" | "exitCode" | "runnerId" |
 "logDigest" | "artifactDigest" | "reusedFromId">;
export function signedPayload(task: SignedTask): Buffer {
  return Buffer.from(JSON.stringify([2, task.id, task.pipelineId, task.kind, task.fingerprint,
    task.image, task.command, task.timeoutSeconds, task.attempt, task.state,
    task.exitCode, task.runnerId, task.logDigest, task.artifactDigest, task.reusedFromId]));
}
export function signTask(task: SignedTask, privateKey = process.env.VALIDATION_SIGNING_PRIVATE_KEY): string {
  if (!privateKey) throw new Error("VALIDATION_SIGNING_PRIVATE_KEY is required in the runner");
  return sign(null, signedPayload(task), createPrivateKey(Buffer.from(privateKey, "base64"))).toString("base64");
}
export function verifyTask(task: SignedTask & { signature: string | null },
  publicKey = process.env.VALIDATION_SIGNING_PUBLIC_KEY): boolean {
  if (!publicKey || !task.signature) return false;
  try {
    return verify(null, signedPayload(task), createPublicKey(Buffer.from(publicKey, "base64")),
      Buffer.from(task.signature, "base64"));
  } catch { return false; }
}

import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { db } from "./prisma";

const COOKIE_NAME = "devhub_admin";

export function tokenHash(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}
function constantEqual(a: string, b: string): boolean {
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function requiredSecret(name: string): string {
  const value = process.env[name];
  if (!value || value.length < 32 || value.startsWith("replace-")) throw new Error(`${name} must be a strong secret (at least 32 characters)`);
  return value;
}
export function secureSessionValue(): string {
  return createHmac("sha256", requiredSecret("APP_SECRET")).update(requiredSecret("ADMIN_TOKEN")).digest("hex");
}
export function adminTokenValid(token: string): boolean {
  return constantEqual(tokenHash(token), tokenHash(requiredSecret("ADMIN_TOKEN")));
}
export async function isAdminRequest(request?: Request): Promise<boolean> {
  const bearer = request?.headers.get("authorization")?.match(/^Bearer (.+)$/i)?.[1];
  if (bearer) return adminTokenValid(bearer);
  // Direct route handlers may also run in service tests without Next request
  // async storage. No request context must mean unauthenticated, not HTTP 500.
  try {
    const session = (await cookies()).get(COOKIE_NAME)?.value;
    return !!session && constantEqual(session, secureSessionValue());
  } catch {
    return false;
  }
}
export function verifyBrowserOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  const expected = new URL(req.url);
  return new URL(origin).host === expected.host && new URL(origin).protocol === expected.protocol;
}
export async function authenticateAgent(req: Request, scope: string) {
  const bearer = req.headers.get("authorization")?.match(/^Bearer (\S+)$/i)?.[1];
  if (!bearer || bearer.length < 32) return null;
  const credential = await db.agentCredential.findUnique({
    where: { tokenHash: tokenHash(bearer) }, include: { agent: true },
  });
  if (!credential || credential.revokedAt || (credential.expiresAt && credential.expiresAt < new Date())) return null;
  if (credential.agent.status !== "ACTIVE" || !credential.agent.scopes.includes(scope)) return null;
  return credential.agent;
}
export { COOKIE_NAME };

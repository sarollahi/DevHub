import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { db } from "./prisma";
import type { SourceActor } from "../source-control/contracts";

export const COOKIE_NAME = "devhub_session";
const PASSWORD_COST = { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 };

export const tokenHash = (raw: string) => createHash("sha256").update(raw).digest("hex");
export const generateCredential = () => randomBytes(32).toString("base64url");

export function passwordDigest(password: string, salt = randomBytes(16).toString("hex")) {
  if (password.length < 12 || password.length > 256) throw new Error("Password must contain 12–256 characters");
  const hash = scryptSync(password, Buffer.from(salt, "hex"), 64, PASSWORD_COST).toString("hex");
  return `scrypt-v1$${salt}$${hash}`;
}

export function verifyPassword(password: string, encoded: string | null): boolean {
  if (!encoded || typeof password !== "string" || password.length > 256) return false;
  const [version, salt, expected] = encoded.split("$");
  if (version !== "scrypt-v1" || !/^[a-f0-9]{32}$/.test(salt ?? "") || !/^[a-f0-9]{128}$/.test(expected ?? "")) return false;
  const actual = scryptSync(password, Buffer.from(salt, "hex"), 64, PASSWORD_COST);
  return timingSafeEqual(actual, Buffer.from(expected, "hex"));
}

export async function sessionIdentity(request?: Request): Promise<SourceActor | null> {
  let value: string | undefined;
  try { value = request ? readCookie(request.headers.get("cookie"), COOKIE_NAME) : (await cookies()).get(COOKIE_NAME)?.value; }
  catch { return null; }
  if (!value || value.length < 32) return null;
  const session = await db.humanSession.findUnique({
    where: { tokenHash: tokenHash(value) }, include: { user: { select: { disabledAt: true } } },
  });
  if (!session || session.revokedAt || session.expiresAt <= new Date() || session.user.disabledAt) return null;
  return { type: "HUMAN", id: session.userId, sessionId: session.id };
}

function readCookie(header: string | null, name: string): string | undefined {
  return header?.split(";").map(part => part.trim()).find(part => part.startsWith(name + "="))?.slice(name.length + 1);
}

export async function requestIdentity(request: Request): Promise<SourceActor | null> {
  const authorization = request.headers.get("authorization");
  if (authorization) {
    const bearer = /^Bearer ([A-Za-z0-9_-]{32,128})$/i.exec(authorization)?.[1];
    if (!bearer) return null; // Never fall back to a browser cookie after an invalid bearer.
    const credential = await db.agentCredential.findUnique({
      where: { tokenHash: tokenHash(bearer) }, include: { agent: true },
    });
    if (!credential || credential.revokedAt || credential.agent.status !== "ACTIVE" ||
      !credential.expiresAt || credential.expiresAt <= new Date()) return null;
    return { type: "AGENT", id: credential.agentId, credentialId: credential.id };
  }
  return sessionIdentity(request);
}

export async function authenticateAgent(request: Request, scope: string) {
  const actor = await requestIdentity(request);
  if (!actor || actor.type !== "AGENT" || !actor.credentialId) return null;
  const credential = await db.agentCredential.findUnique({ where: { id: actor.credentialId }, include: { agent: true } });
  if (!credential || !credential.scopes.includes(scope) || !credential.agent.scopes.includes(scope)) return null;
  return credential.agent;
}

// Compatibility for existing server-rendered pages. This is authentication, not
// global administrator authorization: every data query must remain tenant-scoped.
export async function isAdminRequest(request?: Request) {
  return !!(await sessionIdentity(request));
}

export function verifyBrowserOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    const expected = new URL(request.url);
    const actual = new URL(origin);
    return actual.origin === expected.origin;
  } catch { return false; }
}

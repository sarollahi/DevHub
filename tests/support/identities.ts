import { randomBytes } from "node:crypto";
import { db } from "../../src/lib/prisma";
import { tokenHash } from "../../src/lib/auth";

export async function testSession(userId: string) {
  const token = randomBytes(32).toString("base64url");
  const row = await db.humanSession.create({ data: {
    userId, tokenHash: tokenHash(token), expiresAt: new Date(Date.now() + 3600000),
  } });
  return { actor: { type: "HUMAN" as const, id: userId, sessionId: row.id },
    headers: { cookie: "devhub_session=" + token, origin: "http://localhost:3000" } };
}
export async function testCredential(agentId: string, repositoryId: string, delegatedBy: string, scopes: string[]) {
  const raw = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 3600000);
  const credential = await db.agentCredential.create({ data: {
    agentId, tokenHash: tokenHash(raw), label: "integration", scopes, expiresAt,
  } });
  await db.agentDelegation.create({ data: { agentId, repositoryId, delegatedBy, scopes, expiresAt } });
  return { raw, actor: { type: "AGENT" as const, id: agentId, credentialId: credential.id }, credential };
}

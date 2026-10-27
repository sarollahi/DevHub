import { createHmac } from "node:crypto";
import { db } from "../src/lib/prisma";
import { sha256 } from "../src/lib/review-logic";
import { passwordDigest } from "../src/lib/auth";

async function main() {
  const password = process.env.BOOTSTRAP_USER_PASSWORD;
  if (!password || password.length < 12) throw new Error("Set BOOTSTRAP_USER_PASSWORD to a random 12+ character password");
  const rootToken = process.env.BOOTSTRAP_AGENT_TOKEN;
  if (!rootToken || rootToken.length < 32 || rootToken.startsWith("replace-")) throw new Error("Set BOOTSTRAP_AGENT_TOKEN to a random 32+ character secret");
  const agentCount = Math.min(20, Math.max(1, Number(process.env.SEED_AGENT_COUNT ?? 1)));
  const user = await db.user.upsert({ where: { handle: "sarollahi" },
    create: { handle: "sarollahi", email: "ahmad.sarollahi@gmail.com", passwordHash: passwordDigest(password) }, update: {} });
  const organization = await db.organization.upsert({ where: { slug: "devhub" },
    create: { slug: "devhub", name: "DevHub" }, update: {} });
  await db.organizationMembership.upsert({ where: { organizationId_userId: {
    organizationId: organization.id, userId: user.id } },
    create: { organizationId: organization.id, userId: user.id, role: "OWNER" }, update: {} });
  const repo = await db.repository.upsert({ where: { ownerId_slug: { ownerId: user.id, slug: "DevHub" } },
    create: { ownerId: user.id, organizationId: organization.id, slug: "DevHub", name: "DevHub", defaultBranch: "main" }, update: { organizationId: organization.id } });
  for (let n = 0; n < agentCount; n++) {
    const name = n === 0 ? "seed-agent" : `load-agent-${n}`;
    const raw = n === 0 ? rootToken : createHmac("sha256", rootToken).update(`devhub-load-agent-${n}`).digest("hex");
    const agent = await db.agentIdentity.upsert({ where: { ownerId_name: { ownerId: user.id, name } },
      create: { ownerId: user.id, name, scopes: ["pull_requests:write", "changesets:write", "changesets:read"] }, update: { scopes: ["pull_requests:write", "changesets:write", "changesets:read"] } });
    await db.agentDelegation.create({ data: { agentId: agent.id, repositoryId: repo.id,
      delegatedBy: user.id, scopes: ["changesets:read", "changesets:write", "pull_requests:write"],
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) } });
    await db.agentCredential.upsert({ where: { tokenHash: sha256(raw) }, create: { agentId: agent.id, tokenHash: sha256(raw), label: "seed", scopes: ["changesets:read", "changesets:write", "pull_requests:write"], expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) }, update: { scopes: ["changesets:read", "changesets:write", "pull_requests:write"], expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), revokedAt: null } });
  }
  console.log(`Seed complete: sarollahi/${repo.slug}, ${agentCount} agent identity(ies). No raw credentials stored.`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => db.$disconnect());

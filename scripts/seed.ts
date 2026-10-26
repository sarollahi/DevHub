import { createHmac } from "node:crypto";
import { db } from "../src/lib/prisma";
import { sha256 } from "../src/lib/review-logic";

async function main() {
  const rootToken = process.env.BOOTSTRAP_AGENT_TOKEN;
  if (!rootToken || rootToken.length < 32 || rootToken.startsWith("replace-")) throw new Error("Set BOOTSTRAP_AGENT_TOKEN to a random 32+ character secret");
  const agentCount = Math.min(20, Math.max(1, Number(process.env.SEED_AGENT_COUNT ?? 1)));
  const user = await db.user.upsert({ where: { handle: "sarollahi" },
    create: { handle: "sarollahi", email: "ahmad.sarollahi@gmail.com" }, update: {} });
  const repo = await db.repository.upsert({ where: { ownerId_slug: { ownerId: user.id, slug: "DevHub" } },
    create: { ownerId: user.id, slug: "DevHub", name: "DevHub", defaultBranch: "main" }, update: {} });
  for (let n = 0; n < agentCount; n++) {
    const name = n === 0 ? "seed-agent" : `load-agent-${n}`;
    const raw = n === 0 ? rootToken : createHmac("sha256", rootToken).update(`devhub-load-agent-${n}`).digest("hex");
    const agent = await db.agentIdentity.upsert({ where: { ownerId_name: { ownerId: user.id, name } },
      create: { ownerId: user.id, name, scopes: ["pull_requests:write"] }, update: {} });
    await db.agentCredential.upsert({ where: { tokenHash: sha256(raw) }, create: { agentId: agent.id, tokenHash: sha256(raw), label: "seed" }, update: {} });
  }
  console.log(`Seed complete: sarollahi/${repo.slug}, ${agentCount} agent identity(ies). No raw credentials stored.`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => db.$disconnect());

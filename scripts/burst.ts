import { createHmac, randomUUID } from "node:crypto";

async function main() {
  const root = process.env.BOOTSTRAP_AGENT_TOKEN;
  if (!root || root.length < 32) throw new Error("Set BOOTSTRAP_AGENT_TOKEN and seed agents first");
  const rootToken: string = root;
  const endpoint = (process.env.DEVHUB_URL ?? "http://localhost:3000").replace(/\/$/, "") + "/api/v1/pull-requests";
  const count = Math.min(5000, Math.max(1, Number(process.env.BURST_COUNT ?? 1000)));
  const concurrency = Math.min(100, Math.max(1, Number(process.env.BURST_CONCURRENCY ?? 20)));
  const agents = Math.min(20, Math.max(1, Number(process.env.SEED_AGENT_COUNT ?? 10)));
  const runId = randomUUID();
  const stats: Record<string, number> = { accepted: 0, existing: 0, rateLimited: 0, otherErrors: 0 };
  let next = 0;
  const start = performance.now();
  async function send() {
    while (next < count) {
      const index = next++;
      const agentIndex = index % agents;
      const bearer = agentIndex === 0 ? rootToken : createHmac("sha256", rootToken).update(`devhub-load-agent-${agentIndex}`).digest("hex");
      const patch = `diff --git a/docs/load-${index}.md b/docs/load-${index}.md\n+synthetic check ${index}`;
      const body = { repository: "sarollahi/DevHub", title: `Synthetic contribution ${index}`,
        sourceBranch: `load/${runId.slice(0,8)}-${index}`, targetBranch: "main",
        sourceSha: index.toString(16).padStart(40, "0"), targetSha: "1".repeat(40),
        patch, changedFiles: [`docs/load-${index}.md`] };
      try {
        const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json",
          "Authorization": `Bearer ${bearer}`, "Idempotency-Key": `load-${runId}-${index}` }, body: JSON.stringify(body) });
        if (response.status === 202) stats.accepted++;
        else if (response.status === 200) stats.existing++;
        else if (response.status === 429) stats.rateLimited++;
        else { stats.otherErrors++; if (stats.otherErrors < 4) console.error("Failure", response.status, await response.text()); }
      } catch (error) { stats.otherErrors++; if (stats.otherErrors < 4) console.error(error); }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, send));
  console.log(JSON.stringify({ requested: count, ...stats, seconds: Number(((performance.now() - start) / 1000).toFixed(2)),
    note: "Measures HTTP ingestion only. Synthetic SHAs and patches do not prove Git or CI throughput." }, null, 2));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });

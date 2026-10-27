import { db } from "../lib/prisma";
import { processNextIntegration } from "./service";
async function main() {
  let stopped = false;
  process.on("SIGTERM", () => { stopped = true; });
  process.on("SIGINT", () => { stopped = true; });
  const count = Math.min(32, Math.max(1, Number(process.env.INTEGRATION_CONCURRENCY || 6)));
  async function loop() {
    while (!stopped) {
      try {
        if (await processNextIntegration()) continue;
      } catch (err) { console.error("Integration scheduler failed", err); }
      await new Promise(resolve => setTimeout(resolve, 750));
    }
  }
  try { await Promise.all(Array.from({ length: count }, () => loop())); }
  finally { await db.$disconnect(); }
}
if (process.argv[1]?.endsWith("integration/worker.ts"))
  main().catch(error => { console.error(error); process.exitCode = 1; });

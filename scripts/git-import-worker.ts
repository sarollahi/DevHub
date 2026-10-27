import { db } from "../src/lib/prisma";
import { runGitImport } from "../src/source-control/git-importer";

async function main() {
  let running = true;
  process.on("SIGTERM", () => { running = false; });
  process.on("SIGINT", () => { running = false; });
  while (running) {
    const pending = await db.gitImportJob.findFirst({
      where: { OR: [
        { status: { in: ["QUEUED", "VERIFY_QUEUED"] } },
        { status: { in: ["RUNNING", "VERIFYING"] }, leaseUntil: { lt: new Date() } },
      ] }, orderBy: { createdAt: "asc" }, select: { id: true },
    });
    if (pending) {
      try {
        const result = await runGitImport(pending.id);
        console.info("Import completed", pending.id, result);
      } catch (error) { console.error("Import worker:", pending.id, error); }
    } else {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => db.$disconnect());

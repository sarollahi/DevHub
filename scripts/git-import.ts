import { db } from "../src/lib/prisma";
import { tokenHash } from "../src/lib/auth";
import type { SourceActor } from "../src/source-control/contracts";
import { createGitImport, requestGitImport, runGitImport } from "../src/source-control/git-importer";

async function importActor(): Promise<SourceActor> {
  const token = process.env.GIT_IMPORT_SESSION_TOKEN;
  if (!token) throw new Error("Set GIT_IMPORT_SESSION_TOKEN to an active human session token");
  const session = await db.humanSession.findUnique({ where: { tokenHash: tokenHash(token) } });
  if (!session || session.revokedAt || session.expiresAt <= new Date()) throw new Error("Import session invalid or expired");
  return { type: "HUMAN", id: session.userId, sessionId: session.id };
}
async function main() {
  const [command, argument, directory] = process.argv.slice(2);
  if (command === "start" && argument && directory) {
    const job = await createGitImport(argument, directory, await importActor());
    if (job.status !== "QUEUED") await requestGitImport(job.id, false, await importActor());
    process.stdout.write(JSON.stringify({ jobId: job.id, state: "QUEUED" }) + "\n");
    process.stdout.write(JSON.stringify(await runGitImport(job.id)) + "\n");
  } else if ((command === "resume" || command === "verify") && argument) {
    await requestGitImport(argument, command === "verify", await importActor());
    process.stdout.write(JSON.stringify(await runGitImport(argument)) + "\n");
  } else if (command === "inspect" && argument) {
    const job = await db.gitImportJob.findUniqueOrThrow({ where: { id: argument } });
    process.stdout.write(JSON.stringify(job, null, 2) + "\n");
  } else {
    throw new Error("Usage: npm run import:git -- start <repository-uuid> <path-under-GIT_IMPORT_ROOT> | resume <job-uuid> | verify <job-uuid> | inspect <job-uuid>");
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => db.$disconnect());

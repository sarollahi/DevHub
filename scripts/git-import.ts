import { db } from "../src/lib/prisma";
import { createGitImport, requestGitImport, runGitImport } from "../src/source-control/git-importer";

async function main() {
  const [command, argument, directory] = process.argv.slice(2);
  if (command === "start" && argument && directory) {
    const job = await createGitImport(argument, directory);
    if (job.status !== "QUEUED") await requestGitImport(job.id);
    process.stdout.write(JSON.stringify({ jobId: job.id, state: "QUEUED" }) + "\n");
    process.stdout.write(JSON.stringify(await runGitImport(job.id)) + "\n");
  } else if ((command === "resume" || command === "verify") && argument) {
    await requestGitImport(argument, command === "verify");
    process.stdout.write(JSON.stringify(await runGitImport(argument)) + "\n");
  } else if (command === "inspect" && argument) {
    const job = await db.gitImportJob.findUniqueOrThrow({ where: { id: argument } });
    process.stdout.write(JSON.stringify(job, null, 2) + "\n");
  } else {
    throw new Error("Usage: npm run import:git -- start <repository-uuid> <path-under-GIT_IMPORT_ROOT> | resume <job-uuid> | verify <job-uuid> | inspect <job-uuid>");
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => db.$disconnect());

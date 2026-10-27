import { db } from "../src/lib/prisma";

// Accounting is grounded in persistent rows, not process-local counters.
// Durations are runner wall time, not CPU consumption or an invoice.
const max = Number(process.argv.find(x => x.startsWith("--limit="))?.split("=")[1] || 100);
if (!Number.isSafeInteger(max) || max < 1 || max > 500) throw new Error("--limit must be 1..500");
try {
  const repositories = await db.repository.findMany({ take: max, orderBy: { id: "asc" },
    select: { id: true, ownerId: true, organizationId: true, storedBytes: true } });
  const rows = [];
  for (const repo of repositories) {
    const [changesets, validations, integrations, jobs, objectGrants] = await Promise.all([
      db.sourceChangeset.count({ where: { repositoryId: repo.id } }),
      db.validationPipeline.count({ where: { repositoryId: repo.id } }),
      db.changeIntegration.count({ where: { repositoryId: repo.id } }),
      db.validationTask.findMany({ where: { pipeline: { repositoryId: repo.id }, startedAt: { not: null }, finishedAt: { not: null } },
        select: { startedAt: true, finishedAt: true, state: true } }),
      db.sourceObjectGrant.count({ where: { repositoryId: repo.id } }),
    ]);
    const runnerWallSeconds = jobs.reduce((sum, j) =>
      sum + Math.max(0, (j.finishedAt!.getTime() - j.startedAt!.getTime()) / 1000), 0);
    rows.push({ tenantId: repo.organizationId || repo.ownerId, repositoryId: repo.id,
      storedBytes: repo.storedBytes.toString(), objectGrants, changesets, validations,
      integrations, runnerWallSeconds: Math.round(runnerWallSeconds * 100) / 100,
      accountingBasis: "recorded server-side operations; no cost estimate or CPU attribution" });
  }
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), repositoryLimit: max,
    repositories: rows, limitations: ["Shared objects may be granted in multiple repositories",
      "No measured per-tenant CPU, egress or cache-service cost",
      "Runner wall time is not billable vCPU time"] }, null, 2));
} finally { await db.$disconnect(); }

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
    const [changesets, validations, integrations, jobs, objectGrants, gitTraffic, uploads] = await Promise.all([
      db.sourceChangeset.count({ where: { repositoryId: repo.id } }),
      db.validationPipeline.count({ where: { repositoryId: repo.id } }),
      db.changeIntegration.count({ where: { repositoryId: repo.id } }),
      db.validationTask.findMany({ where: { pipeline: { repositoryId: repo.id }, startedAt: { not: null }, finishedAt: { not: null } },
        select: { startedAt: true, finishedAt: true, state: true, measuredCpuNanos: true, sampledMemoryPeakBytes: true, containerNetworkRxBytes: true, containerNetworkTxBytes: true, resourceMeasurementStatus: true } }),
      db.sourceObjectGrant.count({ where: { repositoryId: repo.id } }),
      db.gitTrafficUsage.aggregate({ where: { repositoryId: repo.id },
        _sum: { ingressBytes: true, egressBytes: true } }),
      db.blobTransfer.aggregate({ where: { repositoryId: repo.id, state: "FINISHED" },
        _sum: { rawInputBytes: true, encodedPutBytes: true }, _count: { id: true } }),
    ]);
    const runnerWallSeconds = jobs.reduce((sum, j) =>
      sum + Math.max(0, (j.finishedAt!.getTime() - j.startedAt!.getTime()) / 1000), 0);
    const measuredCpuNanos = jobs.reduce((sum, j) => sum + (j.measuredCpuNanos ?? 0n), 0n);
    const cpuSampledTasks = jobs.filter(j => j.resourceMeasurementStatus === "SAMPLED").length;
    const memoryPeak = jobs.reduce((peak, j) =>
      j.sampledMemoryPeakBytes !== null && j.sampledMemoryPeakBytes > peak ? j.sampledMemoryPeakBytes : peak, 0n);
    const isolatedNetworkRxBytes = jobs.reduce((sum, j) => sum + (j.containerNetworkRxBytes ?? 0n), 0n);
    const isolatedNetworkTxBytes = jobs.reduce((sum, j) => sum + (j.containerNetworkTxBytes ?? 0n), 0n);
    rows.push({ tenantId: repo.organizationId || repo.ownerId, repositoryId: repo.id,
      storedBytes: repo.storedBytes.toString(), objectGrants, changesets, validations,
      integrations, gitIngressBytes: (gitTraffic._sum.ingressBytes ?? 0n).toString(),
       gitEgressBytes: (gitTraffic._sum.egressBytes ?? 0n).toString(),
       uploadedRawBytes: (uploads._sum.rawInputBytes ?? 0n).toString(),
       s3StagingPutBytes: (uploads._sum.encodedPutBytes ?? 0n).toString(),
       completedUploads: uploads._count.id,
       measuredValidationCpuNanos: measuredCpuNanos.toString(), cpuSampledTasks,
       cpuMeasurementCoverage: jobs.length ? cpuSampledTasks / jobs.length : null,
       sampledRunnerMemoryPeakBytes: memoryPeak.toString(),
       containerNetworkRxBytes: isolatedNetworkRxBytes.toString(),
       containerNetworkTxBytes: isolatedNetworkTxBytes.toString(),
       runnerWallSeconds: Math.round(runnerWallSeconds * 100) / 100,
      accountingBasis: "recorded server-side operations; no cost estimate or CPU attribution" });
  }
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), repositoryLimit: max,
    repositories: rows, limitations: ["Shared objects may be granted in multiple repositories",
      "Measured Git transport and S3 staging PUT payloads only; excludes API downloads, S3 verification GET/copy, regional cache, CDN and wire retransmissions",
       "CPU measured only for Docker validation containers with available stats, not API, indexing, review or integration process compute",
       "No complete network-provider cost; asynchronous usage write failures and unmeasured Docker runs are excluded",
      "Runner wall time is not billable vCPU time"] }, null, 2));
} finally { await db.$disconnect(); }

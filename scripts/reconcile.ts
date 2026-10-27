import { db } from "../src/lib/prisma";
import { objectId } from "../src/source-control/storage";
import { recoverPublications, verifyBlob } from "../src/object-store/service";
import { measured } from "../src/observability/telemetry";

const args = new Set(process.argv.slice(2));
const repair = args.has("--recover-publications");
const verifyExternal = args.has("--verify-external");
const sampleArg = process.argv.find(x => x.startsWith("--sample="))?.split("=")[1] ?? "100";
const sample = Number(sampleArg);
if (!Number.isSafeInteger(sample) || sample < 1 || sample > 1000) throw new Error("--sample must be 1..1000");
const reports: { check: string; count: number; severity: "error" | "warning" }[] = [];
function report(check: string, count: number, severity: "error" | "warning" = "error") {
  reports.push({ check, count, severity });
}
try {
  await measured("reconcile", async () => {
    // Cross-repository links are a breach even though IDs exist and satisfy FKs.
    const wrongRefs = await db.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count FROM "SourceReference" r
      JOIN "SourceChangeset" c ON c.id = r."changesetId"
      WHERE c."repositoryId" <> r."repositoryId"`;
    report("cross_tenant_refs", Number(wrongRefs[0]?.count ?? 0n));
    const wrongParents = await db.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count FROM "SourceChangesetParent" p
      JOIN "SourceChangeset" a ON a.id = p."changesetId"
      JOIN "SourceChangeset" b ON b.id = p."parentId"
      WHERE a."repositoryId" <> b."repositoryId"`;
    report("cross_tenant_ancestry", Number(wrongParents[0]?.count ?? 0n));
    const wrongOps = await db.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count FROM "SourceFileOperation" op
      JOIN "SourceChangeset" c ON c.id = op."changesetId"
      LEFT JOIN "SourceObjectGrant" g ON g."repositoryId" = c."repositoryId" AND g."objectId" = op."objectId"
      WHERE op."objectId" IS NOT NULL AND g."objectId" IS NULL`;
    // Legacy V1 objects may predate explicit repository grants: investigate,
    // do not automatically delete or regrant them.
    report("operations_without_grant", Number(wrongOps[0]?.count ?? 0n), "warning");
    const candidates = await db.sourceObject.findMany({ where: { kind: "BLOB", data: { not: null } },
      take: sample, orderBy: { createdAt: "desc" }, select: { id: true, data: true, byteSize: true } });
    let corrupt = 0;
    for (const row of candidates) if (!row.data || BigInt(row.data.length) !== row.byteSize ||
      objectId("BLOB", row.data) !== row.id) corrupt++;
    report("corrupt_sampled_inline_blobs", corrupt);
    const stale = await db.validationTask.count({ where: { state: "RUNNING", leaseUntil: { lt: new Date() } } });
    report("expired_validation_leases", stale, "warning");
    const stuck = await db.storedBlob.count({ where: { state: "PUBLISHING", publishLeaseUntil: { lt: new Date() } } });
    report("expired_publication_leases", stuck, "warning");
    const stalledIndex = await db.sourceQueryIndexJob.count({ where: {
      state: "RUNNING", leaseUntil: { lt: new Date() },
    } });
    report("expired_source_index_leases", stalledIndex, "warning");
    if (verifyExternal) {
      const external = await db.storedBlob.findMany({ where: { state: "READY" }, take: sample,
        orderBy: { createdAt: "desc" } });
      let failed = 0;
      for (const blob of external) { try { await verifyBlob(blob); } catch { failed++; } }
      report("corrupt_sampled_external_blobs", failed);
    }
    if (repair) {
      const recovered = await recoverPublications(undefined, sample);
      console.log(JSON.stringify({ event: "object_recovery", recovered }));
    }
  });
  const errors = reports.filter(r => r.severity === "error" && r.count !== 0);
  console.log(JSON.stringify({ timestamp: new Date().toISOString(),
    sampledInlineObjects: sample, verifiedExternal: verifyExternal, recoveryEnabled: repair,
    checks: reports, status: errors.length ? "FAILED" : "PASS_WITH_WARNINGS_POSSIBLE" }, null, 2));
  if (errors.length) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ status: "ERROR", reason: error instanceof Error ? error.name : "unknown" }));
  process.exitCode = 1;
} finally { await db.$disconnect(); }

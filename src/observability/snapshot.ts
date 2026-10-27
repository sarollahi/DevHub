import { db } from "../lib/prisma";

// Scrapes must stay bounded. Durable queue gauges are shared across replicas;
// process histograms are exported separately by each process.
let latest: { at: number; content: string } | undefined;
let inflight: Promise<string> | undefined;
const gauge = (name: string, value: number) => "# TYPE " + name + " gauge\n" + name + " " + value;
const lag = (createdAt: Date | undefined | null) => createdAt ? Math.max(0, (Date.now() - createdAt.getTime()) / 1000) : 0;
export async function durableMetrics(): Promise<string> {
  if (latest && Date.now() - latest.at < 10_000) return latest.content;
  if (inflight) return inflight;
  inflight = (async () => {
    const [outbox, firstOutbox, index, firstIndex, validations, firstValidation,
      integrations, firstIntegration, publishing, staleValidations, bytes] = await Promise.all([
      db.outboxEvent.count({ where: { state: "PENDING" } }),
      db.outboxEvent.findFirst({ where: { state: "PENDING" }, orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
      db.sourceQueryIndexJob.count({ where: { state: "QUEUED" } }),
      db.sourceQueryIndexJob.findFirst({ where: { state: "QUEUED" }, orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
      db.validationTask.count({ where: { state: { in: ["QUEUED", "RUNNING"] } } }),
      db.validationTask.findFirst({ where: { state: "QUEUED" }, orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
      db.changeIntegration.count({ where: { state: { in: ["QUEUED", "PREPARING"] } } }),
      db.changeIntegration.findFirst({ where: { state: "QUEUED" }, orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
      db.storedBlob.count({ where: { state: "PUBLISHING" } }),
      db.validationTask.count({ where: { state: "RUNNING", leaseUntil: { lt: new Date() } } }),
      db.repository.aggregate({ _sum: { storedBytes: true } }),
    ]);
    const result = [
      gauge("devhub_outbox_pending", outbox),
      gauge("devhub_outbox_oldest_age_seconds", lag(firstOutbox?.createdAt)),
      gauge("devhub_source_index_pending", index),
      gauge("devhub_source_index_oldest_age_seconds", lag(firstIndex?.createdAt)),
      gauge("devhub_validation_active", validations),
      gauge("devhub_validation_oldest_queue_age_seconds", lag(firstValidation?.createdAt)),
      gauge("devhub_validation_expired_leases", staleValidations),
      gauge("devhub_integration_active", integrations),
      gauge("devhub_integration_oldest_queue_age_seconds", lag(firstIntegration?.createdAt)),
      gauge("devhub_object_publications_pending", publishing),
      gauge("devhub_tenant_storage_bytes_total", Number(bytes._sum.storedBytes ?? 0n)),
    ].join("\n") + "\n";
    latest = { at: Date.now(), content: result };
    return result;
  })();
  try { return await inflight; } finally { inflight = undefined; }
}

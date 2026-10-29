import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { db } from "../src/lib/prisma";

// Evidence is *measured* provider/exporter data, never generated financial
// estimates. One metric per category and per tenant is required, including a
// documented zero accompanied by an exporter coverage/attestation record.
const required = [
  "api_ingress_bytes", "api_egress_bytes",
  "git_ingress_bytes", "git_egress_bytes",
  "s3_put_payload_bytes", "s3_get_payload_bytes", "s3_copy_bytes",
  "cache_network_bytes", "worker_cpu_nanoseconds", "database_cpu_nanoseconds",
  "external_egress_bytes", "provider_billed_cost_micros",
] as const;
type Metric = typeof required[number];
type Evidence = {
  value: string; unit: string; source: string; sourceDigestSha256: string;
  collector: string; capturedFrom: string; capturedUntil: string;
};
type Tenant = { tenantId: string; metrics: Record<Metric, Evidence> };
type Report = {
  version: 1; capturedFrom: string; capturedUntil: string;
  tenantReports: Tenant[];
};
const args = new Map(process.argv.slice(2).filter(x=>x.startsWith("--")&&x.includes("="))
  .map(x => { const [name,...rest] = x.slice(2).split("="); return [name,rest.join("=")]; }));
const from = args.get("from");
const until = args.get("until");
const filename = args.get("evidence");
if (!from || !until || !filename || !/^\d{4}-\d\d-\d\dT/.test(from) ||
    !/^\d{4}-\d\d-\d\dT/.test(until) ||
    !Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(until)) ||
    new Date(from) >= new Date(until))
  throw Error("Provide --from=ISO --until=ISO --evidence=path to measured exporter output");
const started = new Date(from), ended = new Date(until);
const raw = await readFile(filename);
const digest = createHash("sha256").update(raw).digest("hex");
const manifest = JSON.parse(raw.toString("utf8")) as Report;
if (manifest.version !== 1 || !Array.isArray(manifest.tenantReports) ||
    manifest.capturedFrom > from || manifest.capturedUntil < until)
  throw Error("Exporter evidence does not cover the entire requested interval");

const failures: Array<{ tenantId?: string; metric?: string; reason: string }> = [];
const fail = (reason:string, tenantId?:string, metric?:string) => {
  if (failures.length < 500) failures.push({ reason, ...(tenantId ? {tenantId}:{}), ...(metric?{metric}:{}) });
};
const repositoryRows = await db.repository.findMany({
  take:5001, select:{ id:true,ownerId:true,organizationId:true },
});
if (repositoryRows.length > 5000) throw Error("Repository inventory exceeds auditor bound; paginate before certification");
const tenants = new Set(repositoryRows.map(x=>x.organizationId||x.ownerId));
const repoToTenant = new Map(repositoryRows.map(x=>[x.id,x.organizationId||x.ownerId]));
const reports = new Map<string,Tenant>();
for (const entry of manifest.tenantReports) {
  if (!entry || !entry.tenantId || reports.has(entry.tenantId)) {
    fail("Missing or duplicated tenant evidence",entry?.tenantId);continue;
  }
  reports.set(entry.tenantId,entry);
  if (!tenants.has(entry.tenantId)) fail("Unknown tenant in evidence",entry.tenantId);
}
const actual = new Map<string,Partial<Record<Metric,bigint>>>();
const add = (tenant:string,metric:Metric,n:bigint) => {
  const counts = actual.get(tenant)||{};
  counts[metric]=(counts[metric]||0n)+n;
  actual.set(tenant,counts);
};
const [git, uploads, cpu] = await Promise.all([
  db.gitTrafficUsage.findMany({ where:{day:{gte:started,lte:ended}},
    select:{repositoryId:true,ingressBytes:true,egressBytes:true}}),
  db.blobTransfer.findMany({ where:{updatedAt:{gte:started,lt:ended},state:"FINISHED"},
    select:{repositoryId:true,encodedPutBytes:true}}),
  db.validationTask.findMany({ where:{finishedAt:{gte:started,lt:ended}},
    select:{pipeline:{select:{repositoryId:true}},measuredCpuNanos:true,resourceMeasurementStatus:true}}),
]);
for (const row of git) {
  const tenant=repoToTenant.get(row.repositoryId);
  if (tenant) {add(tenant,"git_ingress_bytes",row.ingressBytes);add(tenant,"git_egress_bytes",row.egressBytes);}
}
for (const row of uploads) {
  const tenant=repoToTenant.get(row.repositoryId);
  if (tenant && row.encodedPutBytes!==null) add(tenant,"s3_put_payload_bytes",row.encodedPutBytes);
}
let unmeteredValidations=0;
for (const row of cpu) {
  const tenant=repoToTenant.get(row.pipeline.repositoryId);
  if (!tenant)continue;
  if (row.resourceMeasurementStatus !== "SAMPLED" || row.measuredCpuNanos===null)unmeteredValidations++;
  else add(tenant,"worker_cpu_nanoseconds",row.measuredCpuNanos);
}
if(unmeteredValidations>0) fail("Validation container CPU samples missing: "+unmeteredValidations);
let inspected = 0;
for (const tenantId of tenants) {
  const report = reports.get(tenantId);
  if (!report) { fail("No exporter metrics for tenant",tenantId);continue; }
  inspected++;
  for (const metric of required) {
    const item = report.metrics?.[metric];
    if (!item) { fail("Missing provider/exporter category",tenantId,metric);continue; }
    const accepted = /^\d+$/.test(item.value) &&
      item.source.startsWith("https://") &&
      /^[a-f0-9]{64}$/.test(item.sourceDigestSha256) &&
      item.collector.length>=3 &&
      item.capturedFrom<=from && item.capturedUntil>=until;
    if (!accepted) { fail("Invalid or unproven value/coverage",tenantId,metric);continue; }
    const observed=BigInt(item.value);
    const min=actual.get(tenantId)?.[metric]||0n;
    if (observed<min) fail("Exporter amount below durable measured lower bound: "+min,tenantId,metric);
  }
}
const output={
  kind:"end_to_end_tenant_resource_attribution",status:failures.length?"FAILED":"PASS",
  from,until,evidenceSha256:digest,requiredMetrics:[...required],
  repositories:repositoryRows.length,tenantsExpected:tenants.size,tenantsInspected:inspected,
  durableGitRows:git.length,durableS3Uploads:uploads.length,unmeteredValidations,
  failures,limitations:[
    "Only external source records corroborated by exporter provenance are accepted; script does not collect cloud invoices",
    "Provider resource allocation methodology and cost attribution require independent audit",
    "Git day buckets overlap partially selected intervals; use full UTC-day boundaries for strict comparisons",
  ],
};
if(args.get("output"))await writeFile(args.get("output")!,JSON.stringify(output,null,2));
console.log(JSON.stringify(output,null,2));
await db.$disconnect();
if (failures.length) process.exitCode=1;

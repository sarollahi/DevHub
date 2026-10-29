#!/usr/bin/env node
// Measured multi-process workload, not an in-memory simulation of agents.
// Real independent Node clients use the same PG/Redis/S3 backing services,
// each with separate identities and canonical object/changeset/ref mutations.
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";

const options = Object.fromEntries(process.argv.slice(2).filter(s => /^--[^=]+=/.test(s))
  .map(s => s.slice(2).split(/=(.*)/s).slice(0,2)));
const numeric = (key, fallback, min, max) => {
  const n = Number(options[key] ?? fallback);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw Error("Invalid --"+key);
  return n;
};
const clients = numeric("clients", 3, 2, 32);
const iterations = numeric("changesets", 96, 12, 50000);
const submissions = numeric("submissions", 24, 1, iterations);
const concurrency = numeric("concurrency", 10, 1, 2000);
const pollMs = numeric("probe-interval-ms", 300, 100, 10000);
const timeoutSec = numeric("timeout-seconds", 600, 60, 14400);
const outputDir = options.output || "artifacts/distributed-faults/multi-node";
if (process.env.NODE_ENV === "production" && process.env.DEVHUB_ALLOW_PERF_WRITES !== "yes") {
  throw Error("Production deployment write load requires explicit DEVHUB_ALLOW_PERF_WRITES=yes");
}
const apiOrigins = (options.api || "").split(",").filter(Boolean);
if (apiOrigins.some(url => !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(url))
  && process.env.DEVHUB_ALLOW_EXTERNAL_PROBES !== "yes")
  throw Error("Remote API probes require DEVHUB_ALLOW_EXTERNAL_PROBES=yes");
await mkdir(outputDir, { recursive: true });
const run = randomUUID();
const children = [];
const reports = [];
const health = Object.fromEntries(apiOrigins.map(origin => [origin, { count:0, errors:0, samples:[] }]));
let stopped = false, timedOut = false;
const allStarted = performance.now();
const poll = async () => {
  while (!stopped) {
    await Promise.all(apiOrigins.map(async origin => {
      const at = performance.now();
      let ok = false;
      try {
        const reply = await fetch(origin+"/api/health", { signal: AbortSignal.timeout(2500) });
        ok = reply.ok;
      } catch {}
      const entry = health[origin];
      entry.count++; if (!ok) entry.errors++;
      entry.samples.push(performance.now() - at);
    }));
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
};
const pollPromise = poll();
const onSignal = () => {
  stopped = true;
  for (const child of children) child.kill("SIGTERM");
};
process.once("SIGTERM", onSignal);
process.once("SIGINT", onSignal);
const guard = setTimeout(() => {
  timedOut = true;
  onSignal();
  for (const child of children) {
    setTimeout(() => child.kill("SIGKILL"), 3000).unref();
  }
}, timeoutSec * 1000);
guard.unref();

const execute = (index) => new Promise(resolve => {
  const dest = outputDir + "/client-"+index+".json";
  const args = ["--import", "tsx", "scripts/bench-lifecycle.ts",
    "--output="+dest, "--submissions="+submissions, "--changesets="+iterations,
    "--concurrency="+concurrency, "--depth=16", "--monorepo-paths=32",
    "--ref-writers=12", "--integration-jobs=4", "--ci-jobs=0",
    "--queries=12", "--blobs=5"];
  const child = spawn(process.execPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, DEVHUB_CERT_CLIENT: String(index) },
  });
  children.push(child);
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout = (stdout+chunk).slice(-8192); });
  child.stderr.on("data", chunk => { stderr = (stderr+chunk).slice(-8192); });
  child.once("error", error => resolve({ index, exitCode: -1, error: String(error), dest }));
  child.once("exit", code => resolve({ index, exitCode: code, tail: stderr || stdout, dest }));
});
const executions = await Promise.all(Array.from({length:clients}, (_, i) => execute(i)));
stopped = true;
clearTimeout(guard);
await pollPromise;
let totalChangesets = 0, totalSubmissions = 0, totalFailures = 0;
for (const result of executions) {
  try {
    const report = JSON.parse(await readFile(result.dest, "utf8"));
    const phases = report.phases || {};
    const failCount = Object.values(phases).reduce((s, v) =>
      s + Object.values(v.failureCodes || {}).reduce((a,b) => a + b, 0), 0);
    totalChangesets += report.integrity?.persistedAfterIndependentPhase || 0;
    totalSubmissions += phases.concurrent_change_submissions?.completed || 0;
    totalFailures += failCount;
    reports.push({ index: result.index, exitCode: result.exitCode, runId: report.runId,
      failed: report.error || null, phases, resources: report.resources || null,
      integrity: report.integrity || null, failureCount: failCount,
      maxDriverP95Ms: Math.max(0, ...Object.values(phases).map(p => p.p95Ms || 0)),
      maxDriverP99Ms: Math.max(0, ...Object.values(phases).map(p => p.p99Ms || 0)),
    });
  } catch(error) {
    reports.push({ index: result.index, exitCode: result.exitCode,
      error: String(error), logs: result.tail });
  }
}
const percentile = (values, q) => !values.length ? null :
  values.slice().sort((a,b)=>a-b)[Math.ceil(q*values.length)-1];
const probes = Object.fromEntries(Object.entries(health).map(([origin,h]) => [origin, {
  samples:h.count, errors:h.errors, observedErrorRate:h.count ? h.errors/h.count : null,
  p50Ms: percentile(h.samples,.5), p95Ms:percentile(h.samples,.95),
  p99Ms:percentile(h.samples,.99),
}]));
const passed = !timedOut && reports.length === clients && reports.every(r => r.exitCode === 0 &&
  !r.failed && !!r.integrity && r.integrity.refCasWinners === 1 &&
  r.integrity.persistedAfterIndependentPhase === iterations) &&
  Object.values(probes).every(v => v.samples >= 5 && v.errors === 0);
const result = { kind:"multi_process_native_lifecycle_certification",
  status:passed?"PASS":"FAILED", runId:run,
  topology:{ clientProcesses:clients, separateProcessIsolates:true,
    canonicalPostgreSQL:true, separateAppReplicas: apiOrigins.length,
    notes:"Clients perform real canonical DB/native API calls. HTTP probes are health/readiness only; not authenticated business request latency." },
  workload:{ perProcessChangesets:iterations, perProcessSubmissions:submissions,
    totalPersistedChangesets:totalChangesets, totalConcurrentSubmissions:totalSubmissions,
    concurrencyPerProcess:concurrency },
  elapsedSeconds:Number(((performance.now()-allStarted)/1000).toFixed(2)),
  publishedChangesetsPerSecond:Number((totalChangesets/((performance.now()-allStarted)/1000)).toFixed(2)),
  totalDriverReportedFailures:totalFailures, timedOut, probes, reports,
  limitations:["Running independent processes on one CI host does not establish cross-zone or cross-region performance",
    "Driver p95/p99 values are per-phase per-client, not falsely aggregated into global p95/p99",
    "CI scale is configurable; production-scale certification requires actual deployed hardware, network and sustained load"],
};
await writeFile(outputDir+"/summary.json",JSON.stringify(result,null,2));
console.log(JSON.stringify({kind:result.kind,status:result.status,runId:run,
  totalChangesets, elapsedSeconds:result.elapsedSeconds, clients, probes,
  errorReports:reports.filter(x=>x.exitCode!==0||x.failed||x.error) },null,2));
if(!passed)process.exitCode=1;

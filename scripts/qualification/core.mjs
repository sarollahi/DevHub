import { createHash } from "node:crypto";

export const requiredStages = Object.freeze([
  "object-storage", "publication", "indexing", "validation-executed",
  "review-completed", "approval", "integration-completed",
  "atomic-ref", "client-sync", "measured-baseline",
]);
export const requiredScaleCases = Object.freeze([
  "burst-1000", "independent-10000", "history-100000", "history-1000000",
  "files-100000", "files-1000000", "sparse-clients", "validation-storm",
  "review-storm", "integration-race", "cache-cold", "cache-warm",
  "restart-recovery", "network-partition",
]);
export const quantile = (values, fraction) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] : null;
};
export function summarizeSamples(values) {
  return { count: values.length, p50: quantile(values, .50),
    p95: quantile(values, .95), p99: quantile(values, .99) };
}
export function digestManifest(manifest) {
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}
// No throughput/latency target is invented. The envelope is derived only from
// at least three completed, comparable baseline executions, including their
// observed spread. An incomparable topology or an incomplete baseline fails
// closed rather than borrowing a number from a different system.
export function compareMeasuredBaseline(current, baseline, { minimumRuns = 3 } = {}) {
  if (!baseline || !Array.isArray(baseline.runs) || baseline.runs.length < minimumRuns)
    return { status: "UNBASELINED", reason: "At least three complete measured runs required" };
  const comparable = baseline.runs.every(run =>
    run.status === "PASSED" && run.workloadHash === current.workloadHash &&
    run.topologyHash === current.topologyHash &&
    Number.isFinite(run.p95Ms) && Number.isFinite(run.throughputPerSecond));
  if (!comparable || current.workloadHash !== baseline.workloadHash ||
      current.topologyHash !== baseline.topologyHash)
    return { status: "INCOMPARABLE", reason: "Workload or infrastructure differs, or baseline incomplete" };
  if (!Number.isFinite(current.p95Ms) || !Number.isFinite(current.throughputPerSecond))
    return { status: "NO_MEASUREMENT", reason: "Current run lacks measured latency or throughput" };
  const p95 = baseline.runs.map(x => x.p95Ms);
  const tps = baseline.runs.map(x => x.throughputPerSecond);
  const medianP95 = quantile(p95, .5);
  const medianTps = quantile(tps, .5);
  const madLatency = quantile(p95.map(x => Math.abs(x - medianP95)), .5);
  const madThroughput = quantile(tps.map(x => Math.abs(x - medianTps)), .5);
  const latencyCeiling = Math.max(...p95, medianP95 + 3 * 1.4826 * madLatency);
  const throughputFloor = Math.max(0, Math.min(...tps, medianTps - 3 * 1.4826 * madThroughput));
  return {
    status: current.p95Ms <= latencyCeiling && current.throughputPerSecond >= throughputFloor ? "PASSED" : "REGRESSION",
    measuredBaselineRuns: baseline.runs.length, observedLatencyCeilingMs: latencyCeiling,
    observedThroughputFloorPerSecond: throughputFloor,
  };
}
export function qualificationStatus(results, { full = false } = {}) {
  const stages = Object.fromEntries(requiredStages.map(stage => [stage, "NOT_MEASURED"]));
  const workloads = Object.fromEntries(requiredScaleCases.map(c => [c, "NOT_MEASURED"]));
  for (const r of results) {
    if (r.stage && Object.hasOwn(stages, r.stage)) stages[r.stage] = r.status;
    if (r.case && Object.hasOwn(workloads, r.case)) workloads[r.case] = r.status;
  }
  const failed = results.filter(r => r.status === "FAILED" || r.status === "TIMED_OUT");
  const complete = Object.values(stages).every(x => x === "PASSED") &&
    (!full || Object.values(workloads).every(x => x === "PASSED"));
  return { status: failed.length ? "FAILED" : complete ? "QUALIFIED" : "INCOMPLETE",
    failedCases: failed.map(x => x.case || x.name), stages, workloads };
}

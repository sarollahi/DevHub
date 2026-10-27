import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";

// Metrics and log labels are intentionally bounded. Never label by path, SHA,
// exception message, actor, credential, or tenant identifier.
const OPERATIONS = new Set(["blob.stage", "changeset.publish", "ref.mutate", "integration.enqueue",
  "query.read", "validation.submit", "worker.dispatch", "worker.preflight", "worker.integration", "worker.validation", "worker.index", "reconcile"]);
const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60];
type MetricRecord = { count: number; sum: number; buckets: number[]; errors: number };
type Context = { traceId: string; spanId: string };
const context = new AsyncLocalStorage<Context>();
const measurements = new Map<string, MetricRecord>();
let droppedSpans = 0;
let exporterErrors = 0;
const spanBuffer: object[] = [];
let flushing = false;
let flushScheduled = false;
const hex = (size: number) => randomBytes(size).toString("hex");
const safe = (operation: string) => OPERATIONS.has(operation) ? operation : "unknown";

export function parseTraceparent(value: string | null): Context | undefined {
  const match = /^00-([a-f0-9]{32})-([a-f0-9]{16})-[a-f0-9]{2}$/.exec(value || "");
  if (!match || /^0+$/.test(match[1]) || /^0+$/.test(match[2])) return;
  return { traceId: match[1], spanId: match[2] };
}
export function traceHeaders(): { traceparent: string } | Record<string, never> {
  const current = context.getStore();
  return current ? { traceparent: "00-" + current.traceId + "-" + current.spanId + "-01" } : {};
}
export function structuredLog(level: "info" | "warn" | "error", event: string,
  fields: { operation?: string; status?: string; durationMs?: number; traceId?: string } = {}) {
  const active = context.getStore();
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(), level, event: event.replace(/[^a-z0-9_.-]/gi, "").slice(0, 72),
    operation: safe(fields.operation || ""), status: fields.status || "unknown",
    ...(fields.durationMs === undefined ? {} : { durationMs: Math.round(fields.durationMs * 100) / 100 }),
    traceId: fields.traceId || active?.traceId || null,
  }));
}
function observe(operation: string, status: string, seconds: number) {
  const key = safe(operation) + "|" + (status === "ok" ? "ok" : "error");
  const record = measurements.get(key) || { count: 0, sum: 0, errors: 0, buckets: BUCKETS.map(() => 0) };
  record.count++; record.sum += seconds;
  if (status !== "ok") record.errors++;
  BUCKETS.forEach((bound, i) => { if (seconds <= bound) record.buckets[i]++; });
  measurements.set(key, record);
}
async function flush() {
  if (flushing || !spanBuffer.length) return;
  const endpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  if (!endpoint) { spanBuffer.length = 0; return; }
  if (!/^https:\/\//.test(endpoint) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(endpoint)) {
    exporterErrors++; spanBuffer.length = 0; return;
  }
  flushing = true;
  const spans = spanBuffer.splice(0, 64);
  try {
    const response = await fetch(endpoint, {
      method: "POST", headers: { "content-type": "application/json",
        ...(process.env.OTEL_EXPORTER_OTLP_HEADERS_TOKEN
          ? { authorization: "Bearer " + process.env.OTEL_EXPORTER_OTLP_HEADERS_TOKEN } : {}) },
      body: JSON.stringify({ resourceSpans: [{ resource: { attributes: [
        { key: "service.name", value: { stringValue: process.env.OTEL_SERVICE_NAME || "devhub" } },
      ] }, scopeSpans: [{ scope: { name: "devhub.native" }, spans }] }] }),
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error("Trace exporter rejected batch");
  } catch { exporterErrors++; droppedSpans += spans.length; }
  finally { flushing = false; if (spanBuffer.length) void flush(); }
}
export async function measured<T>(operation: string, task: () => Promise<T>,
  inboundTraceparent?: string | null): Promise<T> {
  const parent = context.getStore() || parseTraceparent(inboundTraceparent || null);
  const traceId = parent?.traceId || hex(16);
  const spanId = hex(8);
  const startTimeUnixNano = (BigInt(Date.now()) * 1_000_000n).toString();
  const start = performance.now();
  const run = async () => {
    let status = "ok";
    try { const result = await task(); if (result instanceof Response && result.status >= 400) status = "error"; return result; }
    catch (error) { status = "error"; throw error; }
    finally {
      const seconds = (performance.now() - start) / 1000;
      observe(operation, status, seconds);
      structuredLog(status === "ok" ? "info" : "error", "operation.completed",
        { operation, status, durationMs: seconds * 1000, traceId });
      if (process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) {
        if (spanBuffer.length >= 256) droppedSpans++;
        else spanBuffer.push({
          traceId, spanId, ...(parent ? { parentSpanId: parent.spanId } : {}),
          name: safe(operation), kind: 2, startTimeUnixNano,
          endTimeUnixNano: (BigInt(Date.now()) * 1_000_000n).toString(),
          status: { code: status === "ok" ? 1 : 2 },
        });
        if (spanBuffer.length >= 32) void flush();
        else if (!flushScheduled) {
          flushScheduled = true;
          const timeout = setTimeout(() => { flushScheduled = false; void flush(); }, 1000);
          timeout.unref();
        }
      }
    }
  };
  return context.run({ traceId, spanId }, run);
}
export function metricsText(): string {
  const lines: string[] = [
    "# HELP devhub_operation_duration_seconds Native source-control operation time",
    "# TYPE devhub_operation_duration_seconds histogram",
  ];
  for (const [key, record] of measurements) {
    const [operation, outcome] = key.split("|");
    const labels = 'operation="' + operation + '",outcome="' + outcome + '"';
    BUCKETS.forEach((bound, i) => lines.push(
      'devhub_operation_duration_seconds_bucket{' + labels + ',le="' + bound + '"} ' + record.buckets[i]));
    lines.push('devhub_operation_duration_seconds_bucket{' + labels + ',le="+Inf"} ' + record.count);
    lines.push('devhub_operation_duration_seconds_sum{' + labels + '} ' + record.sum);
    lines.push('devhub_operation_duration_seconds_count{' + labels + '} ' + record.count);
    lines.push('devhub_operation_errors_total{' + labels + '} ' + record.errors);
  }
  const mem = process.memoryUsage();
  lines.push("# TYPE devhub_process_rss_bytes gauge", "devhub_process_rss_bytes " + mem.rss);
  lines.push("# TYPE devhub_process_heap_bytes gauge", "devhub_process_heap_bytes " + mem.heapUsed);
  lines.push("# TYPE devhub_process_cpu_seconds_total counter",
    "devhub_process_cpu_seconds_total " + ((process.cpuUsage().user + process.cpuUsage().system) / 1e6));
  lines.push("# TYPE devhub_trace_spans_dropped_total counter", "devhub_trace_spans_dropped_total " + droppedSpans);
  lines.push("# TYPE devhub_trace_export_errors_total counter", "devhub_trace_export_errors_total " + exporterErrors);
  return lines.join("\n") + "\n";
}
export function resetMetricsForTest() { measurements.clear(); droppedSpans = 0; exporterErrors = 0; }

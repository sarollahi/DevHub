import test from "node:test";
import assert from "node:assert/strict";
import { measured, metricsText, parseTraceparent, traceHeaders, resetMetricsForTest } from "../src/observability/telemetry.ts";

test("spans preserve trace context, bounded labels, and count successes and failures", async () => {
  resetMetricsForTest();
  const traceId = "1".repeat(32), parent = "2".repeat(16);
  assert.equal(parseTraceparent("00-" + traceId + "-" + parent + "-01").traceId, traceId);
  assert.equal(parseTraceparent("00-" + "0".repeat(32) + "-" + parent + "-01"), undefined);
  const received = await measured("changeset.publish", async () => traceHeaders(), "00-" + traceId + "-" + parent + "-01");
  assert.match(received.traceparent, new RegExp("^00-" + traceId + "-[0-9a-f]{16}-01$"));
  await assert.rejects(() => measured("changeset.publish", async () => { throw new Error("sensitive token"); }));
  const output = metricsText();
  assert.match(output, /devhub_operation_duration_seconds_count\{operation="changeset.publish",outcome="ok"\} 1/);
  assert.match(output, /devhub_operation_duration_seconds_count\{operation="changeset.publish",outcome="error"\} 1/);
  assert.doesNotMatch(output, /sensitive token/);
  assert.match(output, /devhub_process_rss_bytes/);
});

import http from "node:http";
import { timingSafeEqual } from "node:crypto";
const endpoint = process.env.CACHE_STATUS_URL;
const token = process.env.CACHE_STATUS_TOKEN;
const secret = process.env.OPS_METRICS_TOKEN;
if (!endpoint || !/^https?:\/\//.test(endpoint) || !token || !secret || secret.length < 32)
  throw new Error("CACHE_STATUS_URL, CACHE_STATUS_TOKEN and OPS_METRICS_TOKEN (32+ chars) required");
const known = ["hits", "misses", "coalesced", "upstreamRequests", "regionalRequests",
  "integrityFailures", "evictions", "rejected", "entries", "bytes", "reservedBytes",
  "active", "queued"];
function auth(header) {
  const a = Buffer.from((header || "").replace(/^Bearer /, "")), b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}
http.createServer(async (req, res) => {
  if (req.url !== "/metrics" || req.method !== "GET" || !auth(req.headers.authorization)) {
    res.writeHead(404); res.end(); return;
  }
  try {
    const response = await fetch(endpoint, { headers: { authorization: "Bearer " + token },
      signal: AbortSignal.timeout(1500) });
    if (!response.ok) throw new Error("Cache unavailable");
    const stats = await response.json();
    const lines = [];
    for (const field of known) {
      const value = stats[field];
      if (!Number.isFinite(value) || value < 0) continue;
      const name = "devhub_cache_" + field.replace(/[A-Z]/g, c => "_" + c.toLowerCase());
      lines.push("# TYPE " + name + " " + (["hits","misses","upstreamRequests","regionalRequests","evictions","rejected","integrityFailures","coalesced"].includes(field) ? "counter" : "gauge"));
      lines.push(name + " " + value);
    }
    lines.push("devhub_cache_origin_breaker_open " + (stats.originCircuitOpen ? 1 : 0));
    lines.push("devhub_cache_region_breaker_open " + (stats.regionalCircuitOpen ? 1 : 0));
    res.writeHead(200, { "content-type": "text/plain; version=0.0.4", "cache-control": "no-store" });
    res.end(lines.join("\n") + "\n");
  } catch {
    res.writeHead(503, { "cache-control": "no-store" }); res.end("cache unavailable");
  }
}).listen(Number(process.env.CACHE_EXPORTER_PORT || 9109), "127.0.0.1");

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { metricsText } from "@/observability/telemetry";
import { durableMetrics } from "@/observability/snapshot";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Never expose process or service health metrics to unauthenticated callers.
export async function GET(request: NextRequest) {
  const secret = process.env.OPS_METRICS_TOKEN;
  const provided = request.headers.get("authorization")?.replace(/^Bearer /, "") || "";
  const valid = !!secret && secret.length >= 32 && Buffer.byteLength(secret) === Buffer.byteLength(provided)
    && timingSafeEqual(Buffer.from(secret), Buffer.from(provided));
  if (!valid) return NextResponse.json({ error: "NOT_FOUND" }, { status: 404,
    headers: { "cache-control": "no-store" } });
  let durable: string;
  try { durable = await durableMetrics(); }
  catch { return NextResponse.json({ error: "UNAVAILABLE" }, { status: 503, headers: { "cache-control": "no-store" } }); }
  return new NextResponse(metricsText() + durable, { headers: {
    "content-type": "text/plain; version=0.0.4; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  } });
}

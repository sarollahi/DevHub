import { NextRequest, NextResponse } from "next/server";
import { authenticateAgent, isAdminRequest } from "@/lib/auth";
import { db } from "@/lib/prisma";
import { IngestError } from "@/services/ingest";
import { ingestLegacyPullRequest } from "@/source-control/compatibility";

export const runtime = "nodejs";
export async function POST(req: NextRequest) {
  const agent = await authenticateAgent(req, "pull_requests:write");
  if (!agent) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  const body = await req.json().catch(() => null);
  try {
    const result = await ingestLegacyPullRequest(agent, body, req.headers.get("idempotency-key") ?? "");
    return NextResponse.json({ id: result.item.id, state: result.item.state, created: result.created,
      statusUrl: `/api/v1/pull-requests/${result.item.id}` }, { status: result.created ? 202 : 200 });
  } catch (error) {
    if (error instanceof IngestError) return NextResponse.json({ error: error.code, message: error.message }, {
      status: error.status, headers: error.retryAfter ? { "Retry-After": String(error.retryAfter) } : {},
    });
    console.error("Ingestion error", error);
    return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
export async function GET(req: NextRequest) {
  if (!(await isAdminRequest(req))) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  const state = req.nextUrl.searchParams.get("state");
  const take = Math.min(100, Math.max(1, Number(req.nextUrl.searchParams.get("limit") || 40)));
  const records = await db.pullRequest.findMany({ where: state && /^[A-Z_]+$/.test(state) ? {
    state: state as "QUEUED" | "RUNNING" | "REVIEW_REQUIRED" | "APPROVED" | "FAILED" | "BLOCKED" | "MERGED" | "CLOSED" | "MERGING",
  } : undefined, orderBy: { createdAt: "desc" }, take,
  select: { id: true, title: true, state: true, riskTier: true, riskScore: true, changedFiles: true,
    createdAt: true, agent: { select: { name: true } }, repository: { select: { slug: true } } } });
  return NextResponse.json({ records });
}

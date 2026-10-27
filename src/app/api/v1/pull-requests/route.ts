import { NextRequest, NextResponse } from "next/server";
import { requestIdentity, sessionIdentity } from "@/lib/auth";
import { permittedRepositoryIds } from "@/lib/tenant";
import { readBoundedJson, sourceFailure } from "@/source-control/http";
import { SourceControlError } from "@/source-control/contracts";
import { db } from "@/lib/prisma";
import { IngestError } from "@/services/ingest";
import { ingestLegacyPullRequest } from "@/source-control/compatibility";

export const runtime = "nodejs";
export async function POST(req: NextRequest) {
  const actor = await requestIdentity(req);
  if (!actor || actor.type !== "AGENT") return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  try {
    const agent = await db.agentIdentity.findUnique({ where: { id: actor.id } });
    if (!agent) throw new SourceControlError(401, "UNAUTHORIZED", "Machine identity missing");
    const body = await readBoundedJson(req, 512_000);
    const result = await ingestLegacyPullRequest(agent, actor, body, req.headers.get("idempotency-key") ?? "");
    return NextResponse.json({ id: result.item.id, state: result.item.state, created: result.created,
      statusUrl: `/api/v1/pull-requests/${result.item.id}` }, { status: result.created ? 202 : 200 });
  } catch (error) {
    if (error instanceof SourceControlError) return sourceFailure(error);
    if (error instanceof IngestError) return NextResponse.json({ error: error.code, message: error.message }, {
      status: error.status, headers: error.retryAfter ? { "Retry-After": String(error.retryAfter) } : {},
    });
    console.error("Ingestion error", error);
    return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
export async function GET(req: NextRequest) {
  const actor = await sessionIdentity(req);
  if (!actor) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  const repositoryIds = await permittedRepositoryIds(actor);
  const state = req.nextUrl.searchParams.get("state");
  const take = Math.min(100, Math.max(1, Number(req.nextUrl.searchParams.get("limit") || 40)));
  const records = await db.pullRequest.findMany({ where: state && /^[A-Z_]+$/.test(state) ? {
    repositoryId: { in: repositoryIds }, state: state as "QUEUED" | "RUNNING" | "REVIEW_REQUIRED" | "APPROVED" | "FAILED" | "BLOCKED" | "MERGED" | "CLOSED" | "MERGING",
  } : { repositoryId: { in: repositoryIds } }, orderBy: { createdAt: "desc" }, take,
  select: { id: true, title: true, state: true, riskTier: true, riskScore: true, changedFiles: true,
    createdAt: true, agent: { select: { name: true } }, repository: { select: { slug: true } } } });
  return NextResponse.json({ records });
}

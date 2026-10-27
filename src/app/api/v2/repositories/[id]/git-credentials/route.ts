import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { requireRepositoryAccess, sourceFailure, readBoundedJson } from "@/source-control/http";
import { assertRepositoryPermission } from "@/lib/authorization";
import { db } from "@/lib/prisma";
import { tokenHash } from "@/lib/auth";
import { SourceControlError } from "@/source-control/contracts";
export const runtime = "nodejs";
const supported = new Set(["source:read", "changeset:write", "ref:update"]);

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { actor } = await requireRepositoryAccess(request, id, "source:read", true);
    const tokens = await db.gitInteropCredential.findMany({ where: { repositoryId: id, userId: actor.id },
      select: { id: true, scopes: true, createdAt: true, lastUsedAt: true, expiresAt: true, revokedAt: true },
      orderBy: { createdAt: "desc" }, take: 100 });
    return NextResponse.json({ apiVersion: 2, tokens });
  } catch (error) { return sourceFailure(error); }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { actor } = await requireRepositoryAccess(request, id, "source:read", true);
    if (!actor.sessionId) throw new SourceControlError(403, "HUMAN_SESSION_REQUIRED", "Human session required");
    const raw = await readBoundedJson(request, 2048);
    if (!raw || typeof raw !== "object") throw new SourceControlError(422, "INVALID_INPUT", "Credential options required");
    const body = raw as { scopes?: unknown; days?: unknown };
    if (!Array.isArray(body.scopes) || !body.scopes.length || body.scopes.length > 3 ||
      body.scopes.some(scope => typeof scope !== "string" || !supported.has(scope)) ||
      new Set(body.scopes).size !== body.scopes.length ||
      !Number.isInteger(body.days) || (body.days as number) < 1 || (body.days as number) > 30) {
      throw new SourceControlError(422, "INVALID_INPUT", "Specify unique Git scopes and a 1–30 day expiration");
    }
    for (const scope of body.scopes as Array<"source:read" | "changeset:write" | "ref:update">) {
      // A token never provides more authority than the active user's grants.
      await assertRepositoryPermission(actor, id, scope, { allowStaging: scope === "changeset:write" });
    }
    const count = await db.gitInteropCredential.count({ where: { repositoryId: id, userId: actor.id,
      revokedAt: null, expiresAt: { gt: new Date() } } });
    if (count >= 20) throw new SourceControlError(429, "GIT_TOKEN_LIMIT", "Revoke an existing credential first");
    const token = "dvg_" + randomBytes(32).toString("base64url");
    const created = await db.gitInteropCredential.create({ data: { repositoryId: id, userId: actor.id,
      tokenHash: tokenHash(token), scopes: body.scopes as string[],
      expiresAt: new Date(Date.now() + (body.days as number) * 86400000) },
      select: { id: true, expiresAt: true, scopes: true } });
    return NextResponse.json({ apiVersion: 2, token, credential: created }, {
      status: 201, headers: { "cache-control": "no-store", "pragma": "no-cache" },
    });
  } catch (error) { return sourceFailure(error); }
}

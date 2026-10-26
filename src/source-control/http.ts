import { NextRequest, NextResponse } from "next/server";
import { db } from "../lib/prisma";
import { authenticateAgent, isAdminRequest, verifyBrowserOrigin } from "../lib/auth";
import { SourceControlError, type SourceActor } from "./contracts";

export async function requireRepositoryAccess(request: NextRequest, repositoryId: string, scope: string, adminOnly = false):
  Promise<{ actor: SourceActor; ownerId: string }> {
  if (!/^[0-9a-f-]{36}$/i.test(repositoryId)) throw new SourceControlError(404, "NOT_FOUND", "Repository not found");
  const repository = await db.repository.findUnique({ where: { id: repositoryId }, select: { ownerId: true } });
  if (!repository) throw new SourceControlError(404, "NOT_FOUND", "Repository not found");
  if (!adminOnly) {
    const agent = await authenticateAgent(request, scope);
    if (agent) {
      if (agent.ownerId !== repository.ownerId) throw new SourceControlError(403, "REPOSITORY_FORBIDDEN", "Agent does not own this repository");
      return { ownerId: repository.ownerId, actor: { id: agent.id, type: "AGENT" } };
    }
  }
  if (!(await isAdminRequest(request))) throw new SourceControlError(401, "UNAUTHORIZED", "Authentication required");
  if (request.method !== "GET" && !request.headers.get("authorization") && !verifyBrowserOrigin(request)) {
    throw new SourceControlError(403, "INVALID_ORIGIN", "Browser origin mismatch");
  }
  return { ownerId: repository.ownerId, actor: { id: repository.ownerId, type: "HUMAN" } };
}

export function sourceFailure(error: unknown) {
  if (error instanceof SourceControlError) return NextResponse.json({ error: error.code, message: error.message }, { status: error.status });
  console.error("Source-control request failed", error);
  return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
}

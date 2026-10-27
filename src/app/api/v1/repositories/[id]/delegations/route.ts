import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/prisma";
import { validPath } from "@/lib/review-logic";
import { canonicalCapability } from "@/lib/authorization";
import { requireHuman, assertRepoAdmin, requireMembership, auditIdentity } from "@/lib/identity-management";
import { sourceFailure, readBoundedJson } from "@/source-control/http";
import { SourceControlError } from "@/source-control/contracts";
type Context = { params: Promise<{ id: string }> };
const allowed = z.enum(["source:read", "changeset:write", "ref:update"]);
const inputSchema = z.object({
  agentId: z.string().uuid(), scopes: z.array(allowed).min(1).max(3),
  branch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/).nullable().optional(),
  pathPrefix: z.string().max(512).refine(validPath).nullable().optional(),
  ttlHours: z.number().int().min(1).max(168),
}).strict();
export async function GET(request: NextRequest, { params }: Context) {
  try {
    const actor = await requireHuman(request);
    const { id } = await params;
    await assertRepoAdmin(actor.id, id);
    return NextResponse.json({ delegations: await db.agentDelegation.findMany({
      where: { repositoryId: id }, select: { id: true, agentId: true, delegatedBy: true, scopes: true,
        branch: true, pathPrefix: true, expiresAt: true, revokedAt: true, createdAt: true },
      orderBy: { createdAt: "desc" },
    }) });
  } catch (error) { return sourceFailure(error); }
}
export async function POST(request: NextRequest, { params }: Context) {
  try {
    const actor = await requireHuman(request, true);
    const { id } = await params;
    const input = inputSchema.parse(await readBoundedJson(request, 16_384));
    const delegation = await db.$transaction(async tx => {
      const repo = await assertRepoAdmin(actor.id, id, tx);
      const agent = await tx.agentIdentity.findUnique({ where: { id: input.agentId } });
      if (!agent || agent.status !== "ACTIVE") throw new SourceControlError(404, "NOT_FOUND", "Active machine not found");
      if (repo.organizationId) await requireMembership(agent.ownerId, repo.organizationId, tx);
      else if (agent.ownerId !== repo.ownerId) throw new SourceControlError(404, "NOT_FOUND", "Machine outside repository");
      if (!input.scopes.every(scope => agent.scopes.some(s => canonicalCapability(s) === scope))) {
        throw new SourceControlError(403, "INSUFFICIENT_SCOPE", "Delegation exceeds machine capabilities");
      }
      const saved = await tx.agentDelegation.create({ data: {
        agentId: input.agentId, repositoryId: id, delegatedBy: actor.id, scopes: input.scopes,
        branch: input.branch ?? null, pathPrefix: input.pathPrefix ?? null,
        expiresAt: new Date(Date.now() + input.ttlHours * 3600000),
      } });
      await auditIdentity(tx, actor.id, "agent.delegation.created", saved.id, id,
        { agentId: input.agentId, scopes: input.scopes, branch: input.branch, pathPrefix: input.pathPrefix });
      return saved;
    });
    return NextResponse.json({ delegation }, { status: 201 });
  } catch (error) { return sourceFailure(error); }
}

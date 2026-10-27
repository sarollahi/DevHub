import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/prisma";
import { validPath } from "@/lib/review-logic";
import { requireHuman, assertRepoAdmin, requireMembership, auditIdentity } from "@/lib/identity-management";
import { sourceFailure, readBoundedJson } from "@/source-control/http";
import { SourceControlError } from "@/source-control/contracts";
type Context = { params: Promise<{ id: string }> };
const inputSchema = z.object({
  subjectType: z.enum(["USER", "TEAM", "AGENT"]), subjectId: z.string().uuid(),
  capability: z.enum(["source:read", "changeset:write", "ref:update", "review", "admin"]),
  effect: z.enum(["ALLOW", "DENY"]).default("ALLOW"),
  pathPrefix: z.string().max(512).refine(validPath).nullable().optional(),
  branch: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/).nullable().optional(),
  expiresAt: z.iso.datetime().nullable().optional(),
}).strict();
export async function GET(request: NextRequest, { params }: Context) {
  try {
    const actor = await requireHuman(request);
    const { id } = await params;
    await assertRepoAdmin(actor.id, id);
    return NextResponse.json({ grants: await db.repositoryGrant.findMany({
      where: { repositoryId: id }, orderBy: { createdAt: "desc" },
    }) });
  } catch (error) { return sourceFailure(error); }
}
export async function POST(request: NextRequest, { params }: Context) {
  try {
    const actor = await requireHuman(request, true);
    const { id } = await params;
    const values = inputSchema.parse(await readBoundedJson(request, 16_384));
    const grant = await db.$transaction(async tx => {
      const repo = await assertRepoAdmin(actor.id, id, tx);
      if (values.subjectType === "AGENT" && ["review", "admin"].includes(values.capability)) {
        throw new SourceControlError(403, "HUMAN_REQUIRED", "Machines cannot receive human review or administrator rights");
      }
      if (values.subjectType === "USER") {
        if (repo.organizationId) await requireMembership(values.subjectId, repo.organizationId, tx);
        else if (repo.ownerId !== values.subjectId) throw new SourceControlError(404, "NOT_FOUND", "User is not a repository member");
      } else if (values.subjectType === "TEAM") {
        const team = await tx.team.findFirst({ where: { id: values.subjectId,
          organizationId: repo.organizationId ?? "00000000-0000-0000-0000-000000000000" } });
        if (!team) throw new SourceControlError(404, "NOT_FOUND", "Team is outside the organization");
      } else {
        const agent = await tx.agentIdentity.findUnique({ where: { id: values.subjectId } });
        if (!agent) throw new SourceControlError(404, "NOT_FOUND", "Machine not found");
        if (repo.organizationId) await requireMembership(agent.ownerId, repo.organizationId, tx);
        else if (repo.ownerId !== agent.ownerId) throw new SourceControlError(404, "NOT_FOUND", "Machine is outside the repository");
      }
      const saved = await tx.repositoryGrant.create({ data: {
        repositoryId: id, ...values, pathPrefix: values.pathPrefix ?? null, branch: values.branch ?? null,
        expiresAt: values.expiresAt ? new Date(values.expiresAt) : null,
      } });
      await auditIdentity(tx, actor.id, "repository.grant.created", saved.id, id,
        { subjectType: values.subjectType, subjectId: values.subjectId, capability: values.capability, effect: values.effect });
      return saved;
    });
    return NextResponse.json({ grant }, { status: 201 });
  } catch (error) { return sourceFailure(error); }
}

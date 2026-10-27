import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/prisma";
import { generateCredential, tokenHash } from "@/lib/auth";
import { canonicalCapability } from "@/lib/authorization";
import { requireHuman, auditIdentity } from "@/lib/identity-management";
import { sourceFailure, readBoundedJson } from "@/source-control/http";
import { SourceControlError } from "@/source-control/contracts";
type Context = { params: Promise<{ id: string }> };
const schema = z.object({ label: z.string().trim().min(1).max(80),
  scopes: z.array(z.enum(["source:read", "changeset:write", "ref:update"])).min(1).max(3),
  ttlMinutes: z.number().int().min(5).max(60),
  revokePrevious: z.boolean().default(false),
}).strict();

export async function POST(request: NextRequest, { params }: Context) {
  try {
    const actor = await requireHuman(request, true);
    const { id } = await params;
    const input = schema.parse(await readBoundedJson(request, 16_384));
    const raw = generateCredential();
    const credential = await db.$transaction(async tx => {
      const agent = await tx.agentIdentity.findUnique({ where: { id } });
      if (!agent || agent.ownerId !== actor.id) throw new SourceControlError(404, "NOT_FOUND", "Machine not found");
      if (agent.status !== "ACTIVE") throw new SourceControlError(403, "MACHINE_DISABLED", "Machine is suspended or revoked");
      if (!input.scopes.every(scope => agent.scopes.some(s => canonicalCapability(s) === scope))) {
        throw new SourceControlError(403, "INSUFFICIENT_SCOPE", "Credential scopes exceed machine capabilities");
      }
      if (input.revokePrevious) {
        await tx.agentCredential.updateMany({ where: { agentId: id, revokedAt: null },
          data: { revokedAt: new Date() } });
      }
      const record = await tx.agentCredential.create({ data: {
        agentId: id, label: input.label, scopes: input.scopes, tokenHash: tokenHash(raw),
        expiresAt: new Date(Date.now() + input.ttlMinutes * 60_000),
      } });
      await auditIdentity(tx, actor.id, input.revokePrevious ? "credential.rotated" : "credential.issued", record.id,
        undefined, { machineId: id, scopes: input.scopes, expiresAt: record.expiresAt });
      return record;
    });
    return NextResponse.json({ credential: { id: credential.id, label: credential.label,
      scopes: credential.scopes, expiresAt: credential.expiresAt }, token: raw },
      { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return sourceFailure(error); }
}

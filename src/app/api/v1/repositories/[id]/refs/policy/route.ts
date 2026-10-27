import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/prisma";
import { requireRepositoryAccess, sourceFailure } from "@/source-control/http";
import { updateReferencePolicy, validateRefName } from "@/source-control/refs";
import { SourceControlError } from "@/source-control/contracts";
export const runtime = "nodejs";
const policySchema = z.object({
  name: z.string().min(1).max(200),
  protected: z.boolean(),
  allowForce: z.boolean(),
  allowDelete: z.boolean(),
  requireApproval: z.boolean(),
}).strict();
type Context = { params: Promise<{ id: string }> };
export async function GET(req: NextRequest, { params }: Context) {
  try {
    const { id } = await params;
    await requireRepositoryAccess(req, id, "changesets:read");
    const name = req.nextUrl.searchParams.get("name");
    if (!name) throw new SourceControlError(422, "INVALID_REFERENCE", "Supply name");
    validateRefName(name);
    const policy = await db.sourceReferencePolicy.findUnique({ where: { repositoryId_name: { repositoryId: id, name } } });
    const repo = await db.repository.findUniqueOrThrow({ where: { id }, select: { defaultBranch: true } });
    return NextResponse.json({ apiVersion: 1,
      policy: policy ?? { name, protected: name === repo.defaultBranch,
        allowForce: false, allowDelete: name !== repo.defaultBranch, requireApproval: name === repo.defaultBranch } });
  } catch (error) { return sourceFailure(error); }
}
export async function PUT(req: NextRequest, { params }: Context) {
  try {
    const { id } = await params;
    const { actor } = await requireRepositoryAccess(req, id, "admin", true);
    const parsed = policySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new SourceControlError(422, "INVALID_INPUT", "Invalid reference policy");
    const { name, ...settings } = parsed.data;
    const policy = await updateReferencePolicy(id, actor, name, settings);
    return NextResponse.json({ apiVersion: 1, policy });
  } catch (error) { return sourceFailure(error); }
}

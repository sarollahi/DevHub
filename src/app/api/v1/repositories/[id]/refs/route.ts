import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireRepositoryAccess, sourceFailure } from "@/source-control/http";
import { listReferences, mutateReference } from "@/source-control/refs";
import { objectIdSchema, SourceControlError } from "@/source-control/contracts";

export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const includeDeleted = req.nextUrl.searchParams.get("includeDeleted") === "true";
    const { actor } = await requireRepositoryAccess(req, id, "changesets:read", includeDeleted);
    return NextResponse.json({ apiVersion: 1, records: await listReferences(id, includeDeleted, actor) });
  } catch (error) { return sourceFailure(error); }
}

const restoreSchema = z.object({
  name: z.string().min(1).max(200),
  changesetId: objectIdSchema,
  expectedGeneration: z.number().int().positive(),
  expectedChangesetId: objectIdSchema.optional(),
  mutationId: z.string().min(1).max(128).optional(),
  force: z.boolean().optional(),
  reason: z.string().max(2000).optional(),
});

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { actor } = await requireRepositoryAccess(req, id, "refs:write", false, { branch: (await req.clone().json().catch(() => null))?.name });
    const parsed = restoreSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new SourceControlError(422, "INVALID_INPUT", "Restoration requires name, changesetId and expectedGeneration");
    const result = await mutateReference(id, actor, {
      ...parsed.data, operation: "RESTORE", mutationId: parsed.data.mutationId ?? randomUUID(),
    });
    return NextResponse.json({ apiVersion: 1, ...result });
  } catch (error) { return sourceFailure(error); }
}

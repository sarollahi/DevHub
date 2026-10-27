import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireRepositoryAccess, sourceFailure } from "@/source-control/http";
import { mutateReference, listReferences, validateRefName } from "@/source-control/refs";
import { objectIdSchema, SourceControlError } from "@/source-control/contracts";
import { db } from "@/lib/prisma";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string; name: string[] }> };
const writeSchema = z.object({
  changesetId: objectIdSchema,
  expectedGeneration: z.number().int().positive().nullable(),
  expectedChangesetId: objectIdSchema.optional(),
  mutationId: z.string().min(1).max(128).optional(),
  kind: z.enum(["BRANCH", "RELEASE", "TAG"]).optional(),
  force: z.boolean().optional(),
  reason: z.string().max(2000).optional(),
});
const deleteSchema = z.object({
  expectedGeneration: z.number().int().positive(),
  expectedChangesetId: objectIdSchema.optional(),
  mutationId: z.string().min(1).max(128).optional(),
});

export async function GET(req: NextRequest, { params }: Context) {
  try {
    const { id, name } = await params;
    await requireRepositoryAccess(req, id, "changesets:read");
    const refName = name.join("/");
    validateRefName(refName);
    const ref = await db.sourceReference.findUnique({ where: {
      repositoryId_name: { repositoryId: id, name: refName },
    } });
    if (!ref || ref.deletedAt) throw new SourceControlError(404, "REFERENCE_NOT_FOUND", "Reference not found");
    return NextResponse.json({ apiVersion: 1, ref });
  } catch (error) { return sourceFailure(error); }
}

export async function PUT(req: NextRequest, { params }: Context) {
  try {
    const { id, name } = await params;
    const { actor } = await requireRepositoryAccess(req, id, "refs:write", false, { branch: name.join("/") });
    const parsed = writeSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new SourceControlError(422, "INVALID_INPUT", "Invalid conditional reference update");
    const input = parsed.data;
    const result = await mutateReference(id, actor, {
      ...input, name: name.join("/"), mutationId: input.mutationId ?? randomUUID(),
      operation: input.expectedGeneration === null ? "CREATE" : "UPDATE",
    });
    return NextResponse.json({ apiVersion: 1, ...result }, { status: input.expectedGeneration === null && !result.replayed ? 201 : 200 });
  } catch (error) { return sourceFailure(error); }
}

export async function DELETE(req: NextRequest, { params }: Context) {
  try {
    const { id, name } = await params;
    const { actor } = await requireRepositoryAccess(req, id, "refs:write", false, { branch: name.join("/") });
    const parsed = deleteSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new SourceControlError(422, "INVALID_INPUT", "Deletion requires expectedGeneration");
    const result = await mutateReference(id, actor, {
      ...parsed.data, name: name.join("/"), operation: "DELETE",
      mutationId: parsed.data.mutationId ?? randomUUID(),
    });
    return NextResponse.json({ apiVersion: 1, ...result });
  } catch (error) { return sourceFailure(error); }
}

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireRepositoryAccess, sourceFailure } from "@/source-control/http";
import { advanceReference } from "@/source-control/service";
import { objectIdSchema, SourceControlError } from "@/source-control/contracts";
export const runtime = "nodejs";
const inputSchema = z.object({
  changesetId: objectIdSchema,
  expectedGeneration: z.number().int().positive().nullable(),
});
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string; name: string[] }> }) {
  try {
    const { id, name } = await params;
    const { ownerId } = await requireRepositoryAccess(req, id, "refs:write", true);
    const parsed = inputSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) throw new SourceControlError(422, "INVALID_INPUT", "Provide changesetId and expectedGeneration (null to create)");
    const ref = await advanceReference(id, name.join("/"), parsed.data.changesetId, parsed.data.expectedGeneration, ownerId);
    return NextResponse.json({ apiVersion: 1, ref });
  } catch (error) { return sourceFailure(error); }
}

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireRepositoryAccess, sourceFailure, readBoundedJson } from "@/source-control/http";
import { startUpload } from "@/source-control/uploads";
import { SourceControlError } from "@/source-control/contracts";
export const runtime = "nodejs";
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { actor } = await requireRepositoryAccess(req, id, "changesets:write");
    const parsed = z.object({ objectId: z.string().regex(/^[a-f0-9]{64}$/), byteSize: z.number().int().min(0).max(4194304) })
      .strict().safeParse(await readBoundedJson(req, 1000));
    if (!parsed.success) throw new SourceControlError(422, "INVALID_UPLOAD", "Provide objectId and byteSize");
    return NextResponse.json({ apiVersion: 2, ...(await startUpload(id, parsed.data.objectId, parsed.data.byteSize, actor)) });
  } catch (error) { return sourceFailure(error); }
}

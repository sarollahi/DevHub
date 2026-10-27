import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/prisma";
import { SourceControlError } from "@/source-control/contracts";
import { readBoundedJson, requireRepositoryAccess, sourceFailure } from "@/source-control/http";
import { enqueueIntegration } from "@/integration/service";
export const runtime = "nodejs";
const sha = z.string().regex(/^[0-9a-f]{64}$/);
const key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/);
const input = z.object({
  sourceChangesetId: sha, targetRef: z.string().min(1).max(200),
  requestKey: key, mode: z.enum(["MERGE","REVERT"]).optional(),
  revertIntegrationId: z.string().uuid().optional(),
  resolutionOfId: z.string().uuid().optional(),
}).strict();
type Context = { params: Promise<{ id: string }> };
export async function POST(request: NextRequest, { params }: Context) {
  try {
    const { id } = await params;
    const parsed = input.parse(await readBoundedJson(request, 4096));
    const { actor } = await requireRepositoryAccess(request, id, "refs:write", false,
      { branch: parsed.targetRef });
    const record = await enqueueIntegration(id, actor, parsed);
    return NextResponse.json({ apiVersion:2, record }, { status: 202 });
  } catch(error) { return sourceFailure(error); }
}
export async function GET(request: NextRequest, { params }: Context) {
  try {
    const { id } = await params;
    await requireRepositoryAccess(request, id, "changesets:read");
    const limit = Number(request.nextUrl.searchParams.get("limit") ?? "50");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new SourceControlError(422, "INVALID_LIMIT", "Limit must be 1 to 100");
    const records = await db.changeIntegration.findMany({
      where: { repositoryId:id }, orderBy: [{ createdAt:"desc" }, { id:"asc" }], take:limit,
    });
    return NextResponse.json({ apiVersion:2, records });
  } catch(error) { return sourceFailure(error); }
}

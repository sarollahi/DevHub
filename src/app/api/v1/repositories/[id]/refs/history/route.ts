import { NextRequest, NextResponse } from "next/server";
import { requireRepositoryAccess, sourceFailure } from "@/source-control/http";
import { referenceHistory } from "@/source-control/refs";
import { SourceControlError } from "@/source-control/contracts";
export const runtime = "nodejs";
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { actor } = await requireRepositoryAccess(req, id, "changesets:read");
    const name = req.nextUrl.searchParams.get("name");
    if (!name) throw new SourceControlError(422, "INVALID_REFERENCE", "Supply name");
    const rawLimit = Number(req.nextUrl.searchParams.get("limit") ?? "100");
    const rawBefore = req.nextUrl.searchParams.get("beforeGeneration");
    const before = rawBefore ? Number(rawBefore) : undefined;
    if (!Number.isSafeInteger(rawLimit) || rawLimit < 1 ||
        (before !== undefined && (!Number.isSafeInteger(before) || before < 1))) {
      throw new SourceControlError(422, "INVALID_INPUT", "Invalid history pagination");
    }
    return NextResponse.json({ apiVersion: 1, records: await referenceHistory(id, name, rawLimit, before, actor) });
  } catch (error) { return sourceFailure(error); }
}

import { NextRequest, NextResponse } from "next/server";
import { validPath } from "@/lib/review-logic";
import { requireRepositoryAccess, sourceFailure } from "@/source-control/http";
import { getCanonicalSnapshot } from "@/source-control/canonical";
import { SourceControlError } from "@/source-control/contracts";
export const runtime = "nodejs";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string; changesetId: string }> }) {
  try {
    const { id, changesetId } = await params;
    await requireRepositoryAccess(request, id, "changesets:read");
    const selects = request.nextUrl.searchParams.getAll("select");
    if (selects.length > 128 || selects.some(x => !/^[fd]:/.test(x) ||
      (x !== "d:." && !validPath(x.slice(2))))) {
      throw new SourceControlError(422, "INVALID_SELECTION", "Expected select=f:path or select=d:path");
    }
    const state = await getCanonicalSnapshot(id, changesetId);
    const entries = selects.length ? state.entries.filter(entry => selects.some(selector => {
      if (selector === "d:.") return true;
      const path = selector.slice(2);
      return selector.startsWith("f:") ? entry.path === path : entry.path.startsWith(path + "/");
    })) : state.entries;
    return NextResponse.json({ apiVersion: 2, changesetId, entries });
  } catch (error) { return sourceFailure(error); }
}

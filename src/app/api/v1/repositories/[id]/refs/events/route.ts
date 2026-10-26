import { NextRequest, NextResponse } from "next/server";
import { requireRepositoryAccess, sourceFailure } from "@/source-control/http";
import { SourceControlError } from "@/source-control/contracts";
import { db } from "@/lib/prisma";
export const runtime = "nodejs";
// The journal is durable and immutable. Consumers must deduplicate event IDs.
// This endpoint intentionally returns a bounded recent window rather than an
// unsafe global high-water mark based on sequence allocation before commit.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await requireRepositoryAccess(req, id, "changesets:read");
    const limit = Number(req.nextUrl.searchParams.get("limit") ?? "100");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      throw new SourceControlError(422, "INVALID_INPUT", "Limit must be 1–200");
    }
    const records = await db.sourceRefMutation.findMany({
      where: { repositoryId: id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit,
    });
    return NextResponse.json({ apiVersion: 1, records });
  } catch (error) { return sourceFailure(error); }
}

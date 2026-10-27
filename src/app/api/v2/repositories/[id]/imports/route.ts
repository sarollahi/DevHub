import { NextRequest, NextResponse } from "next/server";
import { requireRepositoryAccess, sourceFailure, readBoundedJson } from "@/source-control/http";
import { createGitImport } from "@/source-control/git-importer";
import { SourceControlError } from "@/source-control/contracts";
import { db } from "@/lib/prisma";
export const runtime = "nodejs";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await requireRepositoryAccess(request, id, "changesets:read", true);
    const jobs = await db.gitImportJob.findMany({ where: { repositoryId: id },
      take: 50, orderBy: { createdAt: "desc" } });
    return NextResponse.json({ apiVersion: 2, jobs });
  } catch (error) { return sourceFailure(error); }
}
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { actor } = await requireRepositoryAccess(request, id, "changesets:write", true);
    const body = await readBoundedJson(request, 4096);
    if (!body || typeof body !== "object" || !("sourcePath" in body)
      || typeof body.sourcePath !== "string" || body.sourcePath.length > 1024) {
      throw new SourceControlError(422, "INVALID_INPUT", "sourcePath is required");
    }
    let job;
    try { job = await createGitImport(id, body.sourcePath, actor); }
    catch (error) { throw new SourceControlError(422, "INVALID_SOURCE", error instanceof Error ? error.message : "Invalid Git source"); }
    return NextResponse.json({ apiVersion: 2, job }, { status: 202 });
  } catch (error) { return sourceFailure(error); }
}

import { NextRequest, NextResponse } from "next/server";
import { requireRepositoryAccess, sourceFailure, readBoundedJson } from "@/source-control/http";
import { requestGitImport } from "@/source-control/git-importer";
import { SourceControlError } from "@/source-control/contracts";
import { db } from "@/lib/prisma";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string; jobId: string }> };
async function findJob(id: string, jobId: string) {
  const job = await db.gitImportJob.findFirst({ where: { id: jobId, repositoryId: id } });
  if (!job) throw new SourceControlError(404, "NOT_FOUND", "Import job not found");
  return job;
}
export async function GET(request: NextRequest, { params }: Context) {
  try {
    const { id, jobId } = await params;
    await requireRepositoryAccess(request, id, "changesets:read", true);
    return NextResponse.json({ apiVersion: 2, job: await findJob(id, jobId) });
  } catch (error) { return sourceFailure(error); }
}
export async function POST(request: NextRequest, { params }: Context) {
  try {
    const { id, jobId } = await params;
    const { actor } = await requireRepositoryAccess(request, id, "changesets:write", true);
    await findJob(id, jobId);
    const input = await readBoundedJson(request, 1024);
    if (!input || typeof input !== "object" || !("action" in input)
      || (input.action !== "resume" && input.action !== "verify")) {
      throw new SourceControlError(422, "INVALID_INPUT", "Action must be resume or verify");
    }
    try {
      const job = await requestGitImport(jobId, input.action === "verify", actor);
      return NextResponse.json({ apiVersion: 2, job }, { status: 202 });
    } catch (error) {
      throw new SourceControlError(409, "IMPORT_BUSY", error instanceof Error ? error.message : "Import already running");
    }
  } catch (error) { return sourceFailure(error); }
}

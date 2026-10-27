import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { isAdminRequest } from "@/lib/auth";
import { db } from "@/lib/prisma";
import WorkspaceShell from "@/components/workspace-shell";
import GitImportControls from "./git-import-controls";
export const dynamic = "force-dynamic";

export default async function GitImportPage({ params }: { params: Promise<{ id: string }> }) {
  if (!(await isAdminRequest())) redirect("/login");
  const { id } = await params;
  const repo = await db.repository.findUnique({ where: { id }, include: { owner: true } });
  if (!repo) notFound();
  const jobs = await db.gitImportJob.findMany({
    where: { repositoryId: id }, take: 25, orderBy: { createdAt: "desc" },
  });
  return <WorkspaceShell active="/repositories" title="Import a Git repository"
    description={repo.owner.handle + "/" + repo.slug + " · Native, verifiable migration"}>
    <Link href={`/repositories/${id}/source`} className="detail-back">Back to source control</Link>
    <section className="surface-card source-panel">
      <div className="source-panel-heading"><div><h2>Migration management</h2>
        <p>Import an existing server-accessible Git repository. The import worker reads Git objects and publishes native changesets without creating a Git-backed repository.</p>
      </div></div>
      <GitImportControls repositoryId={id} initialJobs={jobs.map(job => ({
        id: job.id, sourcePath: job.sourcePath, status: job.status,
        imported: job.imported, lastGitSha: job.lastGitSha,
        lastError: job.lastError, verifiedAt: job.verifiedAt?.toISOString() ?? null,
      }))}/>
    </section>
  </WorkspaceShell>;
}

import Link from "next/link";
import { redirect } from "next/navigation";
import { sessionIdentity } from "@/lib/auth";
import { permittedRepositoryIds } from "@/lib/tenant";
import { db } from "@/lib/prisma";
import WorkspaceShell from "@/components/workspace-shell";
import Icon from "@/components/icons";
export const dynamic = "force-dynamic";
export default async function RepositoriesPage() {
  const actor = await sessionIdentity();
  if (!actor) redirect("/login");
  const allowed = await permittedRepositoryIds(actor);
  const repositories = await db.repository.findMany({ where: { id: { in: allowed } }, orderBy:{createdAt:"desc"}, include:{owner:{select:{handle:true}},_count:{select:{pullRequests:true}}} });
  return <WorkspaceShell active="/repositories" title="Repositories" description="Manage code ownership, contribution policies, and repository activity."><section className="surface-card directory-card"><div className="directory-heading"><strong>{repositories.length} repositories</strong><span>Browse immutable changesets, derived checks, and versioned references.</span></div>{repositories.length ? <div className="directory-list">{repositories.map(repo=><div key={repo.id} className="directory-row"><span className="directory-icon"><Icon name="folder-git" size={21}/></span><div className="directory-summary"><strong>{repo.owner.handle}/{repo.slug}</strong><span>Default branch <code>{repo.defaultBranch}</code> · Human approval {repo.requireHumanApproval?"required":"optional"}</span></div><span className="directory-count">{repo._count.pullRequests} changes</span><Link href={`/repositories/${repo.id}/browse`} aria-label="Open source-control workspace" className="row-arrow"><Icon name="chevron-right" size={18}/></Link></div>)}</div> : <div className="table-empty"><div className="table-empty-icon"><Icon name="folder-git" size={22}/></div><strong>No repositories configured</strong><p>Repository access is managed by your organization administrator.</p><code>npm run db:seed</code></div>}</section></WorkspaceShell>;
}

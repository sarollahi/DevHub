import { redirect } from "next/navigation";
import { sessionIdentity } from "@/lib/auth";
import { permittedRepositoryIds } from "@/lib/tenant";
import { db } from "@/lib/prisma";
import WorkspaceShell from "@/components/workspace-shell";
import Icon from "@/components/icons";
import { InfoNote, StateBadge } from "@/components/status";
export const dynamic = "force-dynamic";
export default async function MergeQueuePage(){
  const actor = await sessionIdentity();
  if (!actor) redirect("/login");
  const allowed = await permittedRepositoryIds(actor);
  const groups=await db.mergeGroup.findMany({where:{ repositoryId:{in:allowed} },take:50,orderBy:{createdAt:"desc"},include:{repository:{include:{owner:true}},_count:{select:{items:true}}}});
  return <WorkspaceShell active="/merge-queue" title="Merge queue" description="Coordinate validated changes without races on protected branches."><InfoNote>Native Git ref verification and merge coordination are not active in this milestone. No changes can be merged through DevHub yet.</InfoNote><section className="surface-card directory-card merge-card"><div className="directory-heading"><strong>Merge groups</strong><span>Read-only until merge policies and Git hosting are implemented</span></div>{groups.length?<div className="directory-list">{groups.map(g=><div key={g.id} className="directory-row"><span className="directory-icon"><Icon name="git-merge" size={20}/></span><div className="directory-summary"><strong>{g.repository.owner.handle}/{g.repository.slug}</strong><span>Target: {g.targetBranch} · {g._count.items} proposed changes</span></div><StateBadge state={g.state}/></div>)}</div>:<div className="table-empty"><div className="table-empty-icon"><Icon name="git-merge" size={22}/></div><strong>No merge groups yet</strong><p>Once real Git verification and required CI are available, safe merge groups will appear here.</p></div>}</section></WorkspaceShell>;
}

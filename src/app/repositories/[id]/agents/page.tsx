import Link from "next/link";
import { db } from "@/lib/prisma";
import RepositoryNavigation from "@/components/repository-navigation";
import { repositoryWorkspace, repoHref, boundedNumber } from "@/lib/repository-workspace";

export const dynamic="force-dynamic";
export default async function RepositoryAgents({params,searchParams}:{
  params:Promise<{id:string}>;searchParams:Promise<{page?:string}>;
}){
  const {id}=await params;
  const {repository}=await repositoryWorkspace(id);
  const page=boundedNumber((await searchParams).page,1,200);
  const [delegations,activity]=await Promise.all([
    db.agentDelegation.findMany({where:{repositoryId:id},orderBy:{createdAt:"desc"},take:50,
      include:{agent:{select:{name:true,status:true,scopes:true}}}}),
    db.auditEvent.findMany({where:{repositoryId:id,actorType:"AGENT"},
      orderBy:{occurredAt:"desc"},skip:(page-1)*40,take:41}),
  ]);
  return <RepositoryNavigation id={id} label={repository.owner.handle+"/"+repository.slug}
    active="agents" title="Agent identities and activity" description="Delegated machine capabilities and persisted actor audit records.">
    <section className="surface-card repo-section"><div className="repo-toolbar"><strong>Repository delegations</strong><Link href="/access">Manage credentials</Link></div>
      <div className="table-scroll"><table className="data-table repo-table"><thead>
        <tr><th>IDENTITY</th><th>CAPABILITIES</th><th>RESTRICTION</th><th>EXPIRY</th></tr></thead>
      <tbody>{delegations.map(item=><tr key={item.id}><td><strong>{item.agent.name}</strong>
        <span className="row-meta">{item.agent.status}{item.revokedAt?" · revoked":""}</span></td>
        <td>{item.scopes.join(", ")}</td><td>{item.pathPrefix||"All paths"} · {item.branch||"All branches"}</td>
        <td>{item.expiresAt.toLocaleString("en-GB")}</td></tr>)}</tbody></table></div>
      {!delegations.length&&<p className="repo-empty">No machine permissions delegated.</p>}
    </section>
    <section className="surface-card repo-section"><div className="repo-toolbar"><strong>Machine activity</strong></div>
      <div className="table-scroll"><table className="data-table repo-table"><thead>
        <tr><th>ACTOR ID</th><th>ACTION</th><th>SUBJECT</th><th>TIME</th></tr></thead><tbody>
        {activity.slice(0,40).map(item=><tr key={item.id}><td><code>{item.actorId.slice(0,15)}</code></td>
          <td>{item.action}</td><td><code>{item.subjectId?.slice(0,15)||"—"}</code></td>
          <td>{item.occurredAt.toLocaleString("en-GB")}</td></tr>)}</tbody></table></div>
      {!activity.length&&<p className="repo-empty">No recorded machine activity.</p>}
      <div className="repo-pagination">{page>1&&<Link href={repoHref(id,"agents",{page:page-1})}>Previous</Link>}
        {activity.length>40&&<Link href={repoHref(id,"agents",{page:page+1})}>Next</Link>}</div>
    </section>
  </RepositoryNavigation>;
}

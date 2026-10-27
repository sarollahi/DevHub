import Link from "next/link";
import { db } from "@/lib/prisma";
import RepositoryNavigation from "@/components/repository-navigation";
import { repositoryWorkspace, repoHref, boundedNumber } from "@/lib/repository-workspace";

export const dynamic="force-dynamic";
export default async function RepositoryIntegrations({params,searchParams}:{
  params:Promise<{id:string}>;searchParams:Promise<{page?:string}>;
}){
  const {id}=await params;const {repository}=await repositoryWorkspace(id);
  const page=boundedNumber((await searchParams).page,1,200);
  const records=await db.changeIntegration.findMany({where:{repositoryId:id},
    orderBy:[{createdAt:"desc"},{id:"desc"}],skip:(page-1)*40,take:41});
  return <RepositoryNavigation id={id} label={repository.owner.handle+"/"+repository.slug}
    active="integrations" title="Integration history" description="Auditable prepare, validation, ref update, conflict and rollback state.">
    <section className="surface-card repo-section"><div className="repo-toolbar"><strong>Integration requests</strong>
      <Link href={"/merge-queue?repository="+id}>Integration controls</Link></div>
      <div className="table-scroll"><table className="data-table repo-table"><thead>
        <tr><th>CHANGE</th><th>TARGET</th><th>STATE</th><th>RETRIES</th><th>TIME</th></tr></thead><tbody>
      {records.slice(0,40).map(item=><tr key={item.id}><td>
        <Link className="row-title" href={"/reviews/"+item.sourceChangesetId}>{item.mode} · {item.sourceChangesetId.slice(0,12)}</Link>
        {item.lastError&&<span className="repo-error-inline">{item.lastError}</span>}
        </td><td>{item.targetRef}</td><td>{item.state}</td><td>{item.attempts}</td>
        <td>{item.createdAt.toLocaleString("en-GB")}</td></tr>)}</tbody></table></div>
      {!records.length&&<p className="repo-empty">No changeset integrations have been requested.</p>}
      <div className="repo-pagination">{page>1&&<Link href={repoHref(id,"integrations",{page:page-1})}>Previous</Link>}
        {records.length>40&&<Link href={repoHref(id,"integrations",{page:page+1})}>Next</Link>}</div>
    </section>
  </RepositoryNavigation>;
}

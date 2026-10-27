import Link from "next/link";
import { db } from "@/lib/prisma";
import { assertRepositoryPermission } from "@/lib/authorization";
import { runAuthorizedQuery, fileHistory } from "@/source-control/query";
import RepositoryNavigation from "@/components/repository-navigation";
import { repositoryWorkspace, selectedRevision, repoHref, boundedNumber, validRelativePath } from "@/lib/repository-workspace";
import { notFound } from "next/navigation";

export const dynamic="force-dynamic";
export default async function HistoryPage({ params, searchParams }: {
  params: Promise<{ id: string }>; searchParams: Promise<{ path?:string; revision?:string; page?:string }>;
}) {
  const { id } = await params;
  const { actor, repository } = await repositoryWorkspace(id);
  const q = await searchParams;
  const path = q.path || "";
  if (!validRelativePath(path)) notFound();
  if (path) try { await assertRepositoryPermission(actor,id,"source:read",{paths:[path]}); } catch { notFound(); }
  const page = Math.min(200, boundedNumber(q.page,1,200));
  const revision = await selectedRevision(id,q.revision||repository.defaultBranch,actor);
  const file = path ? await runAuthorizedQuery(actor,id,()=>fileHistory(id,revision,path,true,1000)) : null;
  const rows = file ? file.records.slice((page-1)*50,page*50) :
    await db.sourceChangeset.findMany({ where: { repositoryId:id }, orderBy:[{createdAt:"desc"},{id:"desc"}],
      take:51,skip:(page-1)*50,select:{id:true,authorId:true,message:true,createdAt:true,
        _count:{select:{operations:true,parents:true}}} });
  const hasNext = file ? file.records.length>page*50 : rows.length>50;
  return <RepositoryNavigation id={id} label={repository.owner.handle+"/"+repository.slug}
    active="history" title={path?"File history":"Changeset history"} description="Immutable revision lineage and authored file operations.">
    <section className="surface-card repo-section">
      <div className="repo-toolbar"><strong>{path || "All changesets"}</strong><Link href={repoHref(id,"browse",{revision,path})}>View files</Link></div>
      <div className="table-scroll"><table className="data-table repo-table"><thead><tr><th>CHANGESET</th><th>AUTHOR</th><th>DATE</th><th>REVISION</th></tr></thead>
        <tbody>{rows.slice(0,50).map(row=><tr key={"changesetId" in row ? row.changesetId : row.id}>
          <td><span className="row-title">{ "message" in row ? row.message : "" }</span>{ "kind" in row && <span className="row-meta">{row.kind} · {row.path}</span>}</td>
          <td>{row.authorId}</td><td>{new Date(row.createdAt).toLocaleString("en-GB")}</td>
          <td><Link className="text-link" href={repoHref(id,"browse",{revision:("changesetId" in row?row.changesetId:row.id),path})}>
            {("changesetId" in row?row.changesetId:row.id).slice(0,12)}</Link></td>
        </tr>)}</tbody>
      </table></div>
      {!rows.length && <p className="repo-empty">No revisions match this history view.</p>}
      <div className="repo-pagination">{page>1 && <Link href={repoHref(id,"history",{path,revision,page:page-1})}>Newer</Link>}
        {hasNext && <Link href={repoHref(id,"history",{path,revision,page:page+1})}>Older</Link>}
        <span>Page {page} · {rows.slice(0,50).length} revisions</span></div>
    </section>
  </RepositoryNavigation>;
}

import Link from "next/link";
import { db } from "@/lib/prisma";
import RepositoryNavigation from "@/components/repository-navigation";
import { repositoryWorkspace, repoHref } from "@/lib/repository-workspace";

export const dynamic="force-dynamic";
export default async function RepositoryReviews({params,searchParams}:{
  params:Promise<{id:string}>;searchParams:Promise<{cursor?:string}>;
}){
  const {id}=await params;
  const {repository}=await repositoryWorkspace(id);
  const q=await searchParams;
  const cursor=q.cursor&&/^[a-f0-9]{64}$/.test(q.cursor)?q.cursor:null;
  const records=await db.sourceReview.findMany({where:{repositoryId:id},
    orderBy:[{riskScore:"desc"},{createdAt:"desc"},{changesetId:"desc"}],
    ...(cursor?{cursor:{changesetId:cursor},skip:1}:{}),take:51,
    include:{changeset:{select:{message:true,authorId:true,createdAt:true,approvals:{select:{decision:true}}}}}});
  const groups=new Map<string,typeof records>();
  for(const record of records.slice(0,50)){
    const key=record.groupKey||record.changesetId;
    const group=groups.get(key)||[];group.push(record);groups.set(key,group);
  }
  return <RepositoryNavigation id={id} label={repository.owner.handle+"/"+repository.slug}
    active="reviews" title="Contribution review" description="Native review findings, duplicate detection, related-change clusters, and explicit human approvals.">
    <section className="surface-card repo-section">
      <div className="repo-toolbar"><strong>Review groups</strong><Link href="/reviews">All accessible reviews</Link></div>
      {groups.size ? [...groups].map(([key,items])=><div className="repo-review-group" key={key}>
        <header><strong>{items.length>1?"Related changes":"Change"} · {key.slice(0,12)}</strong><span>{items.length} on this page</span></header>
        <div className="table-scroll"><table className="data-table repo-table">
        <thead><tr><th>CHANGE</th><th>RISK</th><th>ANALYSIS</th><th>APPROVAL</th></tr></thead>
        <tbody>{items.map(item=><tr key={item.changesetId}>
          <td><Link href={"/reviews/"+item.changesetId} className="row-title">{item.changeset.message}</Link>
            <span className="row-meta">{item.changeset.authorId} · {item.changesetId.slice(0,12)}</span></td>
          <td>{item.riskTier||"Not scored"} {item.riskScore??""}</td>
          <td>{item.exactDuplicateOf?"Duplicate":item.state}</td>
          <td>{item.changeset.approvals.some(a=>a.decision==="APPROVED")?"Human approved":"Awaiting decision"}</td>
        </tr>)}</tbody></table></div></div>) : <p className="repo-empty">No native reviews have been recorded for this repository.</p>}
      <div className="repo-pagination">{cursor&&<Link href={repoHref(id,"reviews")}>First page</Link>}
        {records.length>50&&<Link href={repoHref(id,"reviews",{cursor:records[49].changesetId})}>Next 50</Link>}
        <span>Prioritized by deterministic risk</span></div>
    </section>
  </RepositoryNavigation>;
}

import Link from "next/link";
import { db } from "@/lib/prisma";
import { assertRepositoryPermission } from "@/lib/authorization";
import RepositoryNavigation from "@/components/repository-navigation";
import { repositoryWorkspace } from "@/lib/repository-workspace";

export const dynamic="force-dynamic";
export default async function RepositorySettings({params}:{params:Promise<{id:string}>}){
  const {id}=await params;
  const {actor,repository}=await repositoryWorkspace(id);
  let admin=false;
  try { await assertRepositoryPermission(actor,id,"admin");admin=true; }catch { /* Render only public repository settings. */ }
  const [policies,grants,org] = admin ? await Promise.all([
    db.sourceReferencePolicy.findMany({where:{repositoryId:id},orderBy:{name:"asc"},take:100}),
    db.repositoryGrant.findMany({where:{repositoryId:id},orderBy:{createdAt:"desc"},take:100}),
    repository.organizationId?db.organization.findUnique({where:{id:repository.organizationId},
      include:{memberships:{include:{user:{select:{handle:true}}}}}}):Promise.resolve(null),
  ]) : [[],[],null] as const;
  return <RepositoryNavigation id={id} label={repository.owner.handle+"/"+repository.slug}
    active="settings" title="Organization and repository settings" description="Permissions are evaluated server-side and all protected ref policies remain authoritative.">
    <section className="surface-card repo-section">
      <div className="repo-toolbar"><strong>Repository</strong>{admin&&<Link href="/access">Manage policies and memberships</Link>}</div>
      <dl className="repo-definition"><dt>Name</dt><dd>{repository.name}</dd><dt>Default branch</dt><dd><code>{repository.defaultBranch}</code></dd>
        <dt>Owner</dt><dd>{repository.owner.handle}</dd></dl>
      {!admin&&<p className="repo-note repo-note-padded">Additional security settings require repository administrator permission.</p>}
    </section>
    {admin&&<>
      <section className="surface-card repo-section"><div className="repo-toolbar"><strong>Protected reference policies</strong></div>
        <div className="table-scroll"><table className="data-table repo-table"><thead><tr><th>REFERENCE</th><th>PROTECTED</th><th>HUMAN APPROVAL</th><th>FORCE</th><th>DELETE</th></tr></thead><tbody>
        {policies.map(p=><tr key={p.name}><td>{p.name}</td><td>{p.protected?"Yes":"No"}</td><td>{p.requireApproval?"Required":"Optional"}</td>
        <td>{p.allowForce?"Allowed":"Blocked"}</td><td>{p.allowDelete?"Allowed":"Blocked"}</td></tr>)}</tbody></table></div>
      </section>
      <section className="surface-card repo-section"><div className="repo-toolbar"><strong>Active permission grants</strong></div>
        <div className="table-scroll"><table className="data-table repo-table"><thead><tr><th>SUBJECT</th><th>CAPABILITY</th><th>EFFECT</th><th>PATH</th><th>BRANCH</th></tr></thead><tbody>
        {grants.map(g=><tr key={g.id}><td><code>{g.subjectType}:{g.subjectId.slice(0,8)}</code></td><td>{g.capability}</td>
          <td>{g.effect}</td><td>{g.pathPrefix||"All"}</td><td>{g.branch||"All"}</td></tr>)}</tbody></table></div>
      </section>
      <section className="surface-card repo-section"><div className="repo-toolbar"><strong>Organization members · {org?.name||"No organization"}</strong></div>
        <div className="table-scroll"><table className="data-table repo-table"><thead><tr><th>MEMBER</th><th>ROLE</th></tr></thead><tbody>
        {org?.memberships.map(m=><tr key={m.userId}><td>{m.user.handle}</td><td>{m.role}</td></tr>)}</tbody></table></div>
      </section>
    </>}
  </RepositoryNavigation>;
}

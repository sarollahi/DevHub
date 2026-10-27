import Link from "next/link";
import { redirect } from "next/navigation";
import WorkspaceShell from "@/components/workspace-shell";
import { sessionIdentity } from "@/lib/auth";
import { permittedRepositoryIds } from "@/lib/tenant";
import { db } from "@/lib/prisma";
import IntegrationControls from "./integration-controls";
export const dynamic = "force-dynamic";
export default async function IntegrationQueue({searchParams}:{searchParams:Promise<{repository?:string}>}){
 const actor=await sessionIdentity();
 if(!actor)redirect("/login");
 const allowed=await permittedRepositoryIds(actor);
 const repos=await db.repository.findMany({where:{id:{in:allowed}},orderBy:{name:"asc"},
   select:{id:true,slug:true,name:true,defaultBranch:true,owner:{select:{handle:true}}}});
 const query=(await searchParams).repository;
 const selected=repos.find(r=>r.id===query)??repos[0];
 const records=selected?await db.changeIntegration.findMany({
   where:{repositoryId:selected.id},orderBy:{createdAt:"desc"},take:75}):[];
 const refs=selected?await db.sourceReference.findMany({where:{
   repositoryId:selected.id,deletedAt:null,kind:"BRANCH"},orderBy:{name:"asc"},
   select:{name:true,changesetId:true,generation:true}}):[];
 const pending=records.filter(r=>["QUEUED","PREPARING","WAITING_CHECKS","WAITING_APPROVAL","RETRY"].includes(r.state)).length;
 const merged=records.filter(r=>r.state==="INTEGRATED").length;
 const conflicts=records.filter(r=>r.state==="CONFLICTED").length;
 return <WorkspaceShell active="/merge-queue" title="Change integration"
   description="Prepare independent changes in parallel; publish one guarded compare-and-swap per branch revision.">
  <section className="integration-metrics">
   <div className="surface-card"><span>Pending work</span><strong>{pending}</strong><small>Durable jobs awaiting preparation, checks or approval</small></div>
   <div className="surface-card"><span>Integrated</span><strong>{merged}</strong><small>Audited ref updates, not speculative merges</small></div>
   <div className="surface-card"><span>Conflicts</span><strong>{conflicts}</strong><small>Exact path-level conflicts requiring a revised changeset</small></div>
  </section>
  <section className="surface-card integration-panel">
   <header className="integration-panel-head"><div><h2>Integration requests</h2><p>Authenticated, signed validation evidence is required for protected refs.</p></div>
    <form method="get"><label htmlFor="integration-repo">Repository</label>
     <select id="integration-repo" name="repository" defaultValue={selected?.id??""}>
     {repos.map(r=><option value={r.id} key={r.id}>{r.owner.handle}/{r.slug}</option>)}</select>
     <button className="tertiary-button" type="submit">View</button></form>
   </header>
   {selected?<IntegrationControls repositoryId={selected.id} refs={refs.map(r=>r.name)}/>:<p className="integration-empty">No accessible repositories</p>}
   {records.length?<div className="table-scroll"><table className="data-table">
    <thead><tr><th>Revision</th><th>Target</th><th>Status</th><th>Preparation</th><th>Created</th><th>Actions</th></tr></thead>
    <tbody>{records.map(r=><tr key={r.id}>
     <td><Link className="row-title" href={"/reviews/"+r.sourceChangesetId}>{r.mode==="REVERT"?"Revert ":"Integrate "}{r.sourceChangesetId.slice(0,12)}</Link>
      <span className="row-meta">{r.affectedPaths.length} affected paths · {r.attempts} ref retries</span></td>
     <td><strong>{r.targetRef}</strong><div className="row-meta">{r.targetGeneration?("observed gen "+r.targetGeneration):"Not prepared"}</div></td>
     <td><span className={"integration-status integration-status-"+r.state.toLowerCase()}>{r.state.replaceAll("_"," ")}</span></td>
     <td>{r.resultChangesetId?<Link href={"/reviews/"+r.resultChangesetId}>Review prepared revision</Link>:"Preparing"}
      {r.lastError?<p className="integration-error">{r.lastError}</p>:null}
      {r.state==="CONFLICTED"&&Array.isArray(r.conflicts)?<ul className="integration-conflicts">{(r.conflicts as {path:string;code:string}[]).slice(0,12).map((c,i)=><li key={i}><code>{c.path}</code> · {c.code}</li>)}</ul>:null}</td>
     <td className="date-cell">{r.createdAt.toLocaleString("en-GB",{dateStyle:"medium",timeStyle:"short"})}</td>
     <td><IntegrationControls repositoryId={selected.id} jobId={r.id} status={r.state}
         resultId={r.resultChangesetId??undefined} compact/></td>
    </tr>)}</tbody></table></div>:<p className="integration-empty">No integration requests for this repository.</p>}
   </section>
 </WorkspaceShell>;
}

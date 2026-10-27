import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { isAdminRequest } from "@/lib/auth";
import { db } from "@/lib/prisma";
import WorkspaceShell from "@/components/workspace-shell";
import { RiskBadge } from "@/components/status";
import ReviewActions from "./review-actions";
export const dynamic="force-dynamic";
export default async function ReviewDetail({params}:{params:Promise<{id:string}>}) {
  if (!(await isAdminRequest())) redirect("/login");
  const {id}=await params;
  if(!/^[0-9a-f]{64}$/.test(id)) notFound();
  const record = await db.sourceReview.findUnique({where:{changesetId:id},include:{
    changeset:{include:{operations:{orderBy:{position:"asc"}},parents:{orderBy:{position:"asc"}},
      validation:true,approvals:true,repository:{select:{name:true,slug:true,ownerId:true}}}},
  }});
  if(!record) notFound();
  const related = Array.isArray(record.related)?record.related as Array<{changesetId:string;kind:string;score:number}>:[];
  const findings = Array.isArray(record.findings)?record.findings as Array<{severity:string;code:string;message:string;advisory:boolean}>:[];
  const approved=record.changeset.approvals.some(a=>a.userId===record.changeset.repository.ownerId && a.decision==="APPROVED");
  const ready=record.state==="COMPLETED" && record.changeset.validation?.state==="SUCCESS";
  return <WorkspaceShell active="/reviews" title="Review changeset" description="Decisions are attached to an immutable source revision.">
    <Link href="/reviews" className="detail-back">← Back to review queue</Link>
    <div className="detail-title-row"><div><h1>{record.changeset.message}</h1><p className="muted">{record.changeset.repository.name} · {record.changeset.authorId}</p></div><RiskBadge tier={record.riskTier}/></div>
    <div className="detail-grid"><section className="surface-card detail-panel">
      <h2>Authoritative analysis</h2><p className="muted">Computed from immutable operations and verified source objects, not submitted patch text.</p>
      <div className="meta-grid"><span>Changeset SHA-256</span><code className="review-long-id">{id}</code>
        <span>State</span><strong>{record.state}</strong><span>Risk</span><strong>{record.riskTier??"Pending"} · {record.riskScore??"—"}</strong>
        <span>Duplicate of</span><code>{record.exactDuplicateOf?.slice(0,16)??"None"}</code>
        <span>Processing time</span><strong>{record.latencyMs==null?"—":record.latencyMs+" ms"}</strong>
        <span>Model provider</span><strong>{record.provider||"Disabled (deterministic only)"}</strong>
        <span>Model confidence</span><strong>{record.confidence==null?"Not reported":Math.round(record.confidence*100)+"%"}</strong>
        <span>Recorded model cost</span><strong>{(Number(record.costMicros)/1_000_000).toFixed(6)} USD</strong></div>
      <h3>Summary</h3><p className="review-summary">{record.summary??record.error??"Queued for analysis"}</p>
      <h3>File operations ({record.changeset.operations.length})</h3><div className="file-list">
        {record.changeset.operations.map(op=><code key={op.path}>{op.kind} · {op.previousPath?op.previousPath+" → ":""}{op.path}</code>)}</div>
      <h3>Findings ({findings.length})</h3>{findings.length?findings.map((f,i)=><div className="review-finding" key={i}>
        <strong>{f.severity} · {f.code}</strong><p>{f.message}</p><small>Advisory: never an authorization decision</small></div>):<p className="detail-muted">No findings recorded.</p>}
      <h3>Related revisions</h3>{related.length?related.map(link=><p key={link.changesetId} className="review-related">
        <Link href={"/reviews/"+link.changesetId}>{link.changesetId.slice(0,15)}</Link>
        <span>{link.kind} · {Math.round(link.score*100)}% signal</span></p>):<p className="detail-muted">No related revisions in the indexed candidate window.</p>}
    </section><aside className="surface-card detail-panel"><h2>Human decision</h2>
      <p>Content checks and model findings do not grant approval or bypass branch policies.</p>
      <div className="note">Integrity validation: {record.changeset.validation?.state??"Unknown"} · Human owner approval: {approved?"Approved":"Not approved"}</div>
      <ReviewActions repositoryId={record.repositoryId} changesetId={id} ready={ready} state={record.state}/>
      <div className="detail-divider"/><h3>Revision binding</h3><p className="muted">Any revised submission receives a different changeset ID. This decision will not follow that revision.</p>
      <h3>Parent revisions</h3>{record.changeset.parents.map(p=><code key={p.parentId} className="review-parent">{p.parentId}</code>)}
    </aside></div>
  </WorkspaceShell>;
}

import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { isAdminRequest } from "@/lib/auth";
import { db } from "@/lib/prisma";
import { canApprove } from "@/lib/review-logic";
import Icon from "@/components/icons";
import WorkspaceShell from "@/components/workspace-shell";
import { InfoNote, RiskBadge, StateBadge } from "@/components/status";
import ApproveButton from "./approve-button";
import { hasVerifiedChecks } from "@/validation/service";
export const dynamic="force-dynamic";
export default async function Detail({params}:{params:Promise<{id:string}>}) {
  if (!(await isAdminRequest())) redirect("/login");
  const { id } = await params;
  const pr = await db.pullRequest.findUnique({where:{id},include:{agent:true,repository:{include:{owner:true}},checks:{orderBy:{createdAt:"desc"}},fingerprints:true,approvals:true}});
  if (!pr) notFound();
  const nativeChecks = pr.nativeChangesetId
    ? await hasVerifiedChecks(pr.repositoryId, pr.nativeChangesetId, null) : false;
  const latestValidation = pr.nativeChangesetId ? await db.validationPipeline.findFirst({
    where: { repositoryId: pr.repositoryId, changesetId: pr.nativeChangesetId, targetChangesetId: null },
    orderBy: { createdAt: "desc" }, include: { tasks: { orderBy: { kind: "asc" } } },
  }) : null;
  return <WorkspaceShell active="/inbox" title="Change review" description="Inspect the proposed patch, validation status, and review requirements.">
    <Link href="/inbox" className="detail-back"><Icon name="arrow-left" size={15}/> Back to contribution inbox</Link>
    <div className="detail-title-row"><div><h1>{pr.title}</h1><div className="detail-subtitle"><strong>{pr.repository.owner.handle}/{pr.repository.slug}</strong><span>·</span><Icon name="git-branch" size={13}/><span>{pr.sourceBranch} → {pr.targetBranch}</span><span>·</span><span>Version {pr.version}</span></div></div><StateBadge state={pr.state}/></div>
    <div className="detail-grid"><section className="surface-card detail-panel"><h2>Proposed change</h2><p className="muted">Submitted by {pr.agent.name} on {pr.createdAt.toLocaleString("en-GB")}</p>
      <div className="meta-grid"><span>Source commit</span><code>{pr.sourceSha}</code><span>Target commit</span><code>{pr.targetSha}</code><span>Preliminary risk</span><span><RiskBadge tier={pr.riskTier}/> {pr.riskScore != null ? `· Score ${pr.riskScore}` : ""}</span><span>Identical fingerprints</span><span>{pr.fingerprints[0]?.relatedCount??0} signals</span></div>
      <h3>Changed paths ({pr.changedFiles.length})</h3><div className="file-list">{pr.changedFiles.length?pr.changedFiles.map(name=><code key={name}>{name}</code>):<span className="detail-muted">No changed paths were submitted.</span>}</div>
      <h3>Submitted patch</h3><InfoNote>This patch and its metadata have not been verified against a real Git repository. Treat them as untrusted contributor input.</InfoNote><pre className="diff">{pr.patch}</pre>
    </section><aside className="surface-card detail-panel"><h2>Validation and decision</h2><p className="muted">Checks below reflect only the validation actually executed.</p><div className="detail-divider"/>
      <h3>Validation checks</h3>{pr.checks.length === 0?<p className="detail-muted">No checks reported yet.</p>:pr.checks.map(c=><div className="check" key={c.id}><strong>{c.name}</strong><StateBadge state={c.state}/><p>{c.summary}</p></div>)}
      <div className="detail-divider"/><h3>Executable validation</h3>
      {pr.nativeChangesetId ? <p className="detail-muted">Native changeset <code>{pr.nativeChangesetId}</code></p> :
        <p className="note">This legacy patch is not linked to an immutable native changeset. Metadata preflight cannot establish that code compiled or passed security checks.</p>}
      {latestValidation ? <div><p>Snapshot: <code>{latestValidation.snapshotDigest}</code></p>
        <p>Execution: <StateBadge state={latestValidation.state}/></p>
        {latestValidation.tasks.map(task => <div className="check" key={task.id}>
          <strong>{task.kind}</strong><StateBadge state={task.state}/>
          <p>{task.summary || "Waiting for isolated runner"}</p></div>)}
        <Link href={`/repositories/${pr.repositoryId}/validations`} className="text-link">Inspect run, logs and artifacts</Link>
        </div> : <p className="detail-muted">No native executable validation submitted.</p>}
      <div className="detail-divider"/><h3>Human approval</h3><p className="detail-muted">An approval is scoped to this change version. It does not bypass repository policies or trigger a merge.</p>
      {nativeChecks && canApprove(pr.state,pr.checks.map(c=>c.state),true)?<ApproveButton id={id}/>:<p className="note">Review approval requires the current native changeset to pass all six signed, executable checks.</p>}
      <div className="approvals-count">{pr.approvals.length} recorded {pr.approvals.length===1?"decision":"decisions"}</div>
      <div className="detail-divider"/><h3>Merge readiness</h3><div className="note"><Icon name="lock" size={15} style={{verticalAlign:"middle",marginRight:7}}/> Merging is disabled until native Git state validation, branch protection, required CI, and merge coordination are implemented.</div>
    </aside></div>
  </WorkspaceShell>;
}

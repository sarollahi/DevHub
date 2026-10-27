import { redirect } from "next/navigation";
import { sessionIdentity } from "@/lib/auth";
import { permittedRepositoryIds } from "@/lib/tenant";
import { db } from "@/lib/prisma";
import WorkspaceShell from "@/components/workspace-shell";
import Icon from "@/components/icons";
import InboxClient from "./inbox-client";
import Link from "next/link";
export const dynamic = "force-dynamic";

export default async function Inbox() {
  const actor = await sessionIdentity();
  if (!actor) redirect("/login");
  const allowed = await permittedRepositoryIds(actor);
  const repoScope = { repositoryId: { in: allowed } };
  const [prs, grouped, duplicates, pendingOutbox, agents, repos, highRisk] = await Promise.all([
    db.pullRequest.findMany({ where: repoScope, orderBy: { createdAt: "desc" }, take: 100, select: { id:true, title:true, state:true, riskTier:true, createdAt:true, sourceBranch:true, changedFiles:true, agent:{ select:{ name:true } }, repository:{ select:{ slug:true, owner:{ select:{ handle:true } } } }, fingerprints:{ select:{ relatedCount:true } } } }),
    db.pullRequest.groupBy({ where: repoScope, by:["state"], _count:{ id:true } }),
    db.changeFingerprint.count({ where:{ ...repoScope, relatedCount:{ gt:0 } } }),
    db.outboxEvent.count({ where:{ state:"PENDING", aggregateType: "PullRequest", aggregateId: { in: (await db.pullRequest.findMany({ where: repoScope, select: { id: true }, take: 1000 })).map(x => x.id) } } }),
    db.agentIdentity.count({ where:{ status:"ACTIVE", ownerId: actor.id } }),
    db.repository.count({ where: { id: { in: allowed } } }),
    db.pullRequest.count({ where:{ ...repoScope, riskTier:{ in:["HIGH","CRITICAL"] }, state:{ in:["REVIEW_REQUIRED","APPROVED"] } } }),
  ]);
  const counts = Object.fromEntries(grouped.map(x => [x.state,x._count.id]));
  const total = grouped.reduce((s,x) => s+x._count.id,0);
  const processing = (counts.QUEUED??0)+(counts.RUNNING??0);
  const review = counts.REVIEW_REQUIRED??0;
  const data = prs.map(pr => ({ id:pr.id,title:pr.title,state:pr.state,riskTier:pr.riskTier,createdAt:pr.createdAt.toISOString(),sourceBranch:pr.sourceBranch, changedFiles:pr.changedFiles.length, agent:pr.agent.name,repository:`${pr.repository.owner.handle}/${pr.repository.slug}`,relatedCount:pr.fingerprints[0]?.relatedCount??0 }));
  return <WorkspaceShell active="/inbox" title="Contribution inbox" description="Review, prioritize, and manage incoming code changes in one place.">
    <div className="metric-grid">
      <div className="metric-card"><div className="metric-top"><span>All contributions</span><span className="metric-icon"><Icon name="git-pull-request" size={18}/></span></div><strong className="metric-number">{total.toLocaleString()}</strong><span className="metric-caption">Across {repos.toLocaleString()} repositories</span></div>
      <div className="metric-card"><div className="metric-top"><span>Needs review</span><span className="metric-icon amber"><Icon name="alert-circle" size={18}/></span></div><strong className="metric-number">{review.toLocaleString()}</strong><span className="metric-caption">Awaiting human decision</span></div>
      <div className="metric-card"><div className="metric-top"><span>In processing</span><span className="metric-icon blue"><Icon name="clock" size={18}/></span></div><strong className="metric-number">{processing.toLocaleString()}</strong><span className="metric-caption">{pendingOutbox} event{pendingOutbox===1?"":"s"} pending dispatch</span></div>
      <div className="metric-card"><div className="metric-top"><span>Related changes</span><span className="metric-icon violet"><Icon name="layers" size={18}/></span></div><strong className="metric-number">{duplicates.toLocaleString()}</strong><span className="metric-caption">Exact fingerprint matches</span></div>
    </div>
    <div className="section-heading"><div><h2>Incoming changes</h2><p>All agent-submitted contributions, ordered by arrival.</p></div><span className="section-detail"><span className="green-dot"/> {agents} active agents</span></div>
    <InboxClient items={data}/>
    <div className="insight-grid"><div className="insight-card"><div className="insight-icon danger"><Icon name="shield" size={19}/></div><div><h3>Security-sensitive changes</h3><p>{highRisk > 0 ? `${highRisk} high-risk or critical contributions are waiting in the review pipeline.` : "No high-risk changes currently await review."} Sensitive paths always require developer attention.</p><Link href="/inbox" className="text-link">Review contributions <Icon name="arrow-right" size={15}/></Link></div></div>
      <div className="insight-card"><div className="insight-icon blue"><Icon name="activity" size={19}/></div><div><h3>Reliable by design</h3><p>Every accepted submission writes a durable database event before background work begins. Worker operations are safely retried.</p><Link href="/agents" className="text-link">View agent identities <Icon name="arrow-right" size={15}/></Link></div></div></div>
  </WorkspaceShell>;
}

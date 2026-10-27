import Link from "next/link";
import { redirect } from "next/navigation";
import WorkspaceShell from "@/components/workspace-shell";
import Icon from "@/components/icons";
import { isAdminRequest } from "@/lib/auth";
import { db } from "@/lib/prisma";
import ReviewBoard from "./review-board";
export const dynamic = "force-dynamic";

export default async function NativeReviews({ searchParams }: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  if (!(await isAdminRequest())) redirect("/login");
  const { cursor } = await searchParams;
  const [reviews, states, metrics, total, duplicates, risky] = await Promise.all([
    db.sourceReview.findMany({
      take: 101,
      ...(cursor && /^[0-9a-f]{64}$/.test(cursor) ? { cursor: { changesetId: cursor }, skip: 1 } : {}),
      orderBy: [{ createdAt: "desc" }, { changesetId: "desc" }],
      include: { changeset: { select: {
        authorId: true, message: true, repository: { select: { slug: true, owner: { select: { handle: true } } } },
        approvals: { select: { decision: true } },
      } } },
    }),
    db.sourceReview.groupBy({ by: ["state"], _count: { _all: true } }),
    db.sourceReview.aggregate({ where: { state: "COMPLETED" }, _avg: { latencyMs: true, confidence: true },
      _sum: { costMicros: true } }),
    db.sourceReview.count(),
    db.sourceReview.count({ where: { exactDuplicateOf: { not: null } } }),
    db.sourceReview.count({ where: { riskTier: { in: ["HIGH", "CRITICAL"] } } }),
  ]);
  const counts = Object.fromEntries(states.map(s => [s.state, s._count._all]));
  const items = reviews.slice(0, 100).map(r => ({
    id: r.changesetId, repositoryId: r.repositoryId,
    title: r.changeset.message, author: r.changeset.authorId,
    repository: r.changeset.repository.owner.handle + "/" + r.changeset.repository.slug,
    createdAt: r.createdAt.toISOString(), state: r.state, riskTier: r.riskTier,
    riskScore: r.riskScore, groupKey: r.groupKey, paths: r.paths,
    duplicateOf: r.exactDuplicateOf,
    relatedCount: Array.isArray(r.related) ? r.related.length : 0,
    approved: r.changeset.approvals.some(a => a.decision === "APPROVED"),
    summary: r.summary, latencyMs: r.latencyMs, confidence: r.confidence,
  }));
  const nextCursor = reviews.length > 100 ? reviews[99].changesetId : null;
  return <WorkspaceShell active="/reviews" title="Intelligent review" description="Authoritative source analysis, grouped for fast human decisions.">
    <div className="metric-grid">
      <div className="metric-card"><div className="metric-top"><span>Native changesets</span><span className="metric-icon blue"><Icon name="git-pull-request" size={18}/></span></div><strong className="metric-number">{total.toLocaleString()}</strong><span className="metric-caption">Across native repositories</span></div>
      <div className="metric-card"><div className="metric-top"><span>Pending analysis</span><span className="metric-icon amber"><Icon name="clock" size={18}/></span></div><strong className="metric-number">{((counts.QUEUED??0)+(counts.RUNNING??0)).toLocaleString()}</strong><span className="metric-caption">{counts.FAILED??0} failed runs need attention</span></div>
      <div className="metric-card"><div className="metric-top"><span>Related changes</span><span className="metric-icon violet"><Icon name="layers" size={18}/></span></div><strong className="metric-number">{duplicates.toLocaleString()}</strong><span className="metric-caption">Verified exact duplicates · {risky} high-risk changes</span></div>
      <div className="metric-card"><div className="metric-top"><span>Average processing</span><span className="metric-icon"><Icon name="activity" size={18}/></span></div><strong className="metric-number">{metrics._avg.latencyMs == null ? "—" : Math.round(metrics._avg.latencyMs).toLocaleString()+" ms"}</strong><span className="metric-caption">Recorded model cost: {Number(metrics._sum.costMicros??0n)/1_000_000} USD</span></div>
    </div>
    <div className="section-heading"><div><h2>Review queue</h2><p>Exact duplicates and overlapping edits are surfaced before independent changes.</p></div><span className="section-detail">{counts.COMPLETED??0} analyzed · {metrics._avg.confidence == null ? "No model confidence recorded" : Math.round(metrics._avg.confidence*100)+"% average model confidence"}</span></div>
    <ReviewBoard items={items}/>
    <div className="review-pagination">
      {cursor && <Link href="/reviews" className="tertiary-button">First page</Link>}
      {nextCursor && <Link href={"/reviews?cursor="+nextCursor} className="tertiary-button">Older changes</Link>}
      <span>{items.length} changes shown on this page; totals cover persisted records.</span>
    </div>
  </WorkspaceShell>;
}

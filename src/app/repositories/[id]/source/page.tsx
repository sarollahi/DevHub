import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { isAdminRequest } from "@/lib/auth";
import { db } from "@/lib/prisma";
import WorkspaceShell from "@/components/workspace-shell";
import SourceControls from "./source-controls";
export const dynamic = "force-dynamic";

export default async function SourcePage({ params }: { params: Promise<{ id: string }> }) {
  if (!(await isAdminRequest())) redirect("/login");
  const { id } = await params;
  const repo = await db.repository.findUnique({ where: { id }, include: { owner: true } });
  if (!repo) notFound();
  const [refs, changesets] = await Promise.all([
    db.sourceReference.findMany({ where: { repositoryId: id }, orderBy: { name: "asc" } }),
    db.sourceChangeset.findMany({ where: { repositoryId: id }, orderBy: { createdAt: "desc" }, take: 50,
      include: { validation: true, approvals: { select: { userId: true, decision: true } }, _count: { select: { operations: true, parents: true } } } }),
  ]);
  const changes = changesets.map(c => ({ id: c.id, message: c.message, approved: c.approvals.some(a => a.userId === repo.ownerId && a.decision === "APPROVED"),
    validation: c.validation?.state ?? "PENDING" }));
  return <WorkspaceShell active="/repositories" title="Source control" description={`${repo.owner.handle}/${repo.slug} · Immutable, server-authoritative changesets`}>
    <Link href="/repositories" className="detail-back">Back to repositories</Link>
    <div className="source-grid">
      <section className="surface-card source-panel">
        <div className="source-panel-heading"><div><h2>References</h2><p>Each move requires the current generation and repository approval policy.</p></div><span className="source-count">{refs.length}</span></div>
        {refs.length === 0 ? <p className="source-empty">No source references yet. Changesets can be stored independently without creating a branch.</p> :
          <div className="source-list">{refs.map(ref => <div key={ref.name} className="source-ref">
            <div><strong>{ref.name}</strong><small>Generation {ref.generation}</small></div><code title={ref.changesetId}>{ref.changesetId.slice(0, 12)}</code>
          </div>)}</div>}
      </section>
      <section className="surface-card source-panel">
        <div className="source-panel-heading"><div><h2>Review and reference control</h2><p>Approval is recorded independently of reference movement.</p></div></div>
        <SourceControls repositoryId={id} changesets={changes} refs={refs.map(ref => ({ name: ref.name, generation: ref.generation, changesetId: ref.changesetId }))}/>
      </section>
    </div>
    <section className="surface-card source-panel source-history">
      <div className="source-panel-heading"><div><h2>Immutable history</h2><p>Each digest identifies stored file operations, parent changesets and a canonical tree.</p></div><span className="source-count">{changesets.length}</span></div>
      {changesets.length ? <div className="table-scroll"><table className="data-table"><thead><tr><th>Changeset</th><th>Content ID</th><th>Files</th><th>Validation</th><th>Approval</th><th>Created</th></tr></thead>
        <tbody>{changesets.map(c => <tr key={c.id}><td><strong className="source-message">{c.message}</strong><span className="source-subline">{c._count.parents} parent(s)</span></td>
          <td><code title={c.id}>{c.id.slice(0, 12)}</code></td><td>{c._count.operations}</td>
          <td>{c.validation?.state === "SUCCESS" ? `Integrity checked · ${c.validation.riskTier}` : "Not validated"}</td>
          <td>{c.approvals.some(a => a.userId === repo.ownerId && a.decision === "APPROVED") ? "Approved" : "Awaiting owner"}</td>
          <td>{c.createdAt.toLocaleString("en-GB")}</td></tr>)}</tbody></table></div> : <p className="source-empty">No changesets. Agents can submit file operations through the versioned source-control API.</p>}
    </section>
  </WorkspaceShell>;
}

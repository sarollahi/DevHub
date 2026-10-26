import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { isAdminRequest } from "@/lib/auth";
import { db } from "@/lib/prisma";
import WorkspaceShell from "@/components/workspace-shell";
import { StateBadge } from "@/components/status";
import { verifyTask } from "@/validation/policy";
import ValidationControls from "./validation-controls";
import LogViewer from "./log-viewer";
export const dynamic="force-dynamic";
export default async function ValidationPage({params}:{params:Promise<{id:string}>}) {
  if(!(await isAdminRequest()))redirect("/login");
  const {id}=await params;
  const repo=await db.repository.findUnique({where:{id},include:{owner:true}});
  if(!repo)notFound();
  const items=await db.validationPipeline.findMany({where:{repositoryId:id},
    orderBy:{createdAt:"desc"},take:25,include:{tasks:{orderBy:{kind:"asc"},
      include:{artifacts:{select:{id:true,name:true,digest:true}}}}}});
  return <WorkspaceShell active="/repositories" title="Execution validation"
    description="Immutable snapshot evidence, signed check results, and isolated runner output.">
    <Link href={"/repositories/"+id+"/source"} className="detail-back">Back to source</Link>
    <div className="surface-card detail-panel">
      <h2>Request validation · {repo.owner.handle}/{repo.slug}</h2>
      <p className="muted">Select a native changeset. A target changeset optionally validates the conflict-checked combined snapshot.</p>
      <ValidationControls repositoryId={id}/>
    </div>
    {items.length===0?<div className="surface-card detail-panel"><p>No executed validations yet.</p></div>:
      items.map(item=><section className="surface-card detail-panel" key={item.id}>
        <div className="detail-title-row"><div>
          <h2>Validation {item.id.slice(0,8)}</h2>
          <p className="muted">{item.createdAt.toLocaleString("en-GB")} · {item.requestedBy}</p>
        </div><StateBadge state={item.state}/></div>
        <div className="meta-grid">
          <span>Changeset</span><code>{item.changesetId}</code>
          <span>Target snapshot</span><code>{item.targetChangesetId||"Changeset only"}</code>
          <span>Snapshot digest</span><code>{item.snapshotDigest}</code>
          <span>Dependency state</span><code>{item.dependencyDigest}</code>
          <span>Configuration</span><code>{item.configurationDigest}</code>
        </div>
        {item.tasks.map(task=><div className="check" key={task.id}>
          <div className="detail-title-row"><strong>{task.kind} · Attempt {task.attempt}</strong>
            <StateBadge state={task.state}/></div>
          <p>{task.summary||"Awaiting runner"}</p>
          <p className="detail-muted">Environment: <code>{task.image}</code></p>
          <p className="detail-muted">Input fingerprint: <code>{task.fingerprint}</code></p>
          <p className="detail-muted">Authenticated result: <strong>{verifyTask(task)?"Verified":"Not verified"}</strong></p>
          <LogViewer endpoint={"/api/v2/repositories/"+id+"/validations/"+item.id+"/tasks/"+task.id+"/logs"}/>
          {task.artifacts.map(a=><p key={a.id}>
            <a className="text-link" href={"/api/v2/repositories/"+id+"/validations/"+item.id+
              "/tasks/"+task.id+"/artifacts/"+a.id}>Artifact: {a.name} · {a.digest.slice(0,12)}</a></p>)}
        </div>)}
      </section>)}
  </WorkspaceShell>;
}

import Link from "next/link";
import { db } from "@/lib/prisma";
import RepositoryNavigation from "@/components/repository-navigation";
import { repositoryWorkspace, repoHref, boundedNumber } from "@/lib/repository-workspace";
import LogViewer from "../validations/log-viewer";

export const dynamic="force-dynamic";
export default async function RepositoryChecks({params,searchParams}:{
  params:Promise<{id:string}>;searchParams:Promise<{page?:string}>;
}){
  const {id}=await params;const {repository}=await repositoryWorkspace(id);
  const page=boundedNumber((await searchParams).page,1,200);
  const records=await db.validationPipeline.findMany({where:{repositoryId:id},
    orderBy:[{createdAt:"desc"},{id:"desc"}],take:21,skip:(page-1)*20,
    include:{tasks:{orderBy:{kind:"asc"},include:{artifacts:{select:{id:true,name:true}}}}}});
  return <RepositoryNavigation id={id} label={repository.owner.handle+"/"+repository.slug}
    active="checks" title="CI checks and logs" description="Persisted validation results with exact source snapshot and execution provenance.">
    <section className="surface-card repo-section"><div className="repo-toolbar"><strong>Validation runs</strong>
      <Link href={repoHref(id,"validations")}>Run a validation</Link></div>
      {records.slice(0,20).map(run=><section className="repo-check" key={run.id}>
        <header><div><strong>{run.changesetId.slice(0,12)}</strong>
          <span>{run.createdAt.toLocaleString("en-GB")} · {run.requestedBy}</span></div>
          <b className={"repo-state repo-state-"+run.state.toLowerCase()}>{run.state}</b></header>
        <div className="repo-check-tasks">{run.tasks.map(task=><div className="repo-check-task" key={task.id}>
          <strong>{task.kind}</strong><span>{task.state}</span>
          <small>{task.summary||"Not yet reported"} · attempt {task.attempt}</small>
          <LogViewer endpoint={"/api/v2/repositories/"+id+"/validations/"+run.id+"/tasks/"+task.id+"/logs"}/>
          {task.artifacts.map(artifact=><a key={artifact.id} href={"/api/v2/repositories/"+id+"/validations/"+run.id+"/tasks/"+task.id+"/artifacts/"+artifact.id}>{artifact.name}</a>)}
        </div>)}</div>
      </section>)}
      {!records.length&&<p className="repo-empty">No CI execution records yet.</p>}
      <div className="repo-pagination">{page>1&&<Link href={repoHref(id,"checks",{page:page-1})}>Previous</Link>}
        {records.length>20&&<Link href={repoHref(id,"checks",{page:page+1})}>Next</Link>}</div>
    </section>
  </RepositoryNavigation>;
}

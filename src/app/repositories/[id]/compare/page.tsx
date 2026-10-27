import Link from "next/link";
import RepositoryNavigation from "@/components/repository-navigation";
import { repositoryWorkspace, repoHref, boundedNumber } from "@/lib/repository-workspace";
import { runAuthorizedQuery, diffQuery } from "@/source-control/query";

export const dynamic="force-dynamic";
export default async function ComparePage({params,searchParams}: {
  params:Promise<{id:string}>;searchParams:Promise<{from?:string;to?:string;offset?:string}>;
}) {
  const {id}=await params;
  const {actor,repository}=await repositoryWorkspace(id);
  const q=await searchParams;
  const from=q.from?.trim()||"";
  const to=q.to?.trim()||repository.defaultBranch;
  const offset=Number(q.offset||0);
  const safeOffset=Number.isSafeInteger(offset)&&offset>=0?Math.min(10000,offset):0;
  const diff=from && to?await runAuthorizedQuery(actor,id,()=>diffQuery(id,from,to,20,safeOffset)).catch(()=>null):null;
  return <RepositoryNavigation id={id} label={repository.owner.handle+"/"+repository.slug}
    active="compare" title="Compare revisions" description="Server-computed file changes and text diffs. Comparison never updates a reference.">
    <section className="surface-card repo-section"><form className="repo-search-form" method="get">
      <label htmlFor="compare-from">Base revision</label><input id="compare-from" name="from" required defaultValue={from} placeholder="Branch or changeset"/>
      <label htmlFor="compare-to">Target revision</label><input id="compare-to" name="to" required defaultValue={to}/>
      <button className="source-action" type="submit">Compare</button></form>
    {!from?<p className="repo-empty">Select two revisions to compute a file comparison.</p>:
      !diff?<p role="alert" className="repo-error">Unable to compare these revisions. Verify both exist and are readable.</p>:
      <><div className="repo-toolbar"><strong>{diff.totalFiles} changed files</strong><span className="repo-note">{diff.from.slice(0,10)} → {diff.to.slice(0,10)}</span></div>
        {diff.files.map(file=><section key={file.path} className="repo-diff-file">
          <div className="repo-diff-title"><Link href={repoHref(id,"browse",{path:file.path,revision:diff.to})}>{file.path}</Link><span>{file.kind}</span></div>
          {file.binary?<p>Binary or large file. Text comparison unavailable.</p>:file.patch?
            <div className="code-scroll" role="region" tabIndex={0} aria-label={"Diff for "+file.path}>
              <pre className="repo-diff-lines">{file.patch.split("\n").map((line,i)=><span key={i}
                className={line.startsWith("+")?"diff-add":line.startsWith("-")?"diff-remove":"diff-context"}>{line+"\n"}</span>)}</pre>
            </div>:<p>Diff unavailable or truncated.</p>}</section>)}
        {diff.nextOffset!==null&&<div className="repo-pagination"><Link href={repoHref(id,"compare",{from,to,offset:diff.nextOffset})}>More changed files</Link></div>}
      </>}
    </section>
  </RepositoryNavigation>;
}

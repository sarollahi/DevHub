import Link from "next/link";
import RepositoryNavigation from "@/components/repository-navigation";
import { repositoryWorkspace, repoHref, boundedNumber } from "@/lib/repository-workspace";
import { searchRepository, type SearchMode } from "@/source-control/search";

export const dynamic = "force-dynamic";
type Params = { id: string };
type Query = { q?: string; mode?: string; revision?: string; cursor?: string; limit?: string };
export default async function RepositorySearch({ params, searchParams }: {
  params: Promise<Params>; searchParams: Promise<Query>;
}) {
  const { id } = await params;
  const { actor, repository } = await repositoryWorkspace(id);
  const query = await searchParams;
  const mode: SearchMode = query.mode === "content" ? "content" : "path";
  const value = (query.q || "").trim().slice(0, 128);
  const limit = boundedNumber(query.limit, 40, 100);
  const revision = query.revision || repository.defaultBranch;
  const result = value.length >= 2 ? await searchRepository({
    repositoryId: id, actor, revision, mode, query: value, cursor: query.cursor, limit,
  }).catch(() => null) : null;
  return <RepositoryNavigation id={id} label={repository.owner.handle + "/" + repository.slug}
    active="search" title="Code search" description="Search tracked paths and indexed UTF-8 content from a specific immutable revision.">
    <section className="surface-card repo-section">
      <form className="repo-search-form" method="get" role="search">
        <label htmlFor="search-q">Search this repository</label>
        <input id="search-q" name="q" maxLength={128} minLength={2} required defaultValue={value}
          placeholder="File path or content" autoFocus/>
        <label htmlFor="search-mode">In</label>
        <select id="search-mode" name="mode" defaultValue={mode}><option value="path">Paths</option><option value="content">File contents</option></select>
        <label htmlFor="search-revision">Revision</label>
        <input id="search-revision" name="revision" defaultValue={revision} maxLength={200}/>
        <button type="submit" className="source-action">Search</button>
      </form>
      {value.length < 2 ? <p className="repo-empty">Enter at least two characters. Search is limited to 100 results per page.</p>
        : !result ? <div role="alert" className="repo-error">Search could not complete. Check the revision and try again.</div>
        : <>
          <div className="repo-toolbar"><strong>Results for “{result.query}”</strong>
            <span className="repo-note">{result.index.state === "INDEXING" ? "Indexing in progress — content matches may be incomplete" :
              result.index.state === "READY" ? "Content index current for this snapshot" : "Paths derived from source snapshot"}</span></div>
          {result.index.largeOrBinaryFilesExcluded && <p className="repo-note repo-note-padded">Binary and files over 256 KiB are excluded from content indexing.</p>}
          {result.records.length ? <div className="table-scroll"><table className="data-table repo-table">
            <thead><tr><th>FILE</th><th>{mode === "content" ? "MATCH" : "OBJECT"}</th></tr></thead>
            <tbody>{result.records.map(row => <tr key={row.path}><td><Link className="row-title" href={repoHref(id, "browse", {
              path: row.path, revision: result.revision, ...(row.line ? { start: row.line } : {}),
            })}>{row.path}</Link></td><td>{row.excerpt ? <span className="repo-excerpt">Line {row.line}: {row.excerpt}</span> :
              <code>{row.objectId.slice(0, 12)}</code>}</td></tr>)}</tbody>
          </table></div> : <p className="repo-empty">No matching indexed files in the selected revision.</p>}
          <div className="repo-pagination">{query.cursor && <Link href={repoHref(id, "search", { q:value,mode,revision:result.revision })}>First page</Link>}
            {result.nextCursor && <Link href={repoHref(id, "search", { q:value,mode,revision:result.revision,cursor:result.nextCursor })}>Next results</Link>}
            <span>{result.records.length} visible results on this page</span></div>
        </>}
    </section>
  </RepositoryNavigation>;
}

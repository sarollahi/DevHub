import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/prisma";
import { assertRepositoryPermission } from "@/lib/authorization";
import { getCanonicalSnapshot } from "@/source-control/canonical";
import { runAuthorizedQuery, blameQuery } from "@/source-control/query";
import { objectId as verifyObject } from "@/source-control/storage";
import { verifiedBlobStream } from "@/object-store/service";
import RepositoryNavigation from "@/components/repository-navigation";
import { SourceCodeTable } from "@/components/source-code-table";
import { repositoryWorkspace, selectedRevision, repoHref, boundedNumber, validRelativePath } from "@/lib/repository-workspace";

export const dynamic = "force-dynamic";
type Params = { id: string };
type Search = { path?: string; revision?: string; cursor?: string; start?: string; view?: string };

async function readFileObject(id: string) {
  const blob = await db.sourceObject.findUnique({ where: { id }, select: {
    id: true, kind: true, byteSize: true, data: true, externalId: true,
  } });
  if (!blob || blob.kind !== "BLOB") return { error: "Object unavailable" };
  if (blob.byteSize > 512_000n) return { error: "Large file. Download the verified object to view the full contents." };
  let bytes: Buffer;
  if (blob.data) {
    if (verifyObject("BLOB", blob.data) !== blob.id) return { error: "Integrity check failed" };
    bytes = Buffer.from(blob.data);
  } else {
    if (blob.externalId !== blob.id) return { error: "Invalid object identity" };
    const stored = await db.storedBlob.findFirst({ where: { id, state: "READY" } });
    if (!stored) return { error: "Object is not available for reading" };
    const chunks: Buffer[] = [];
    for await (const part of await verifiedBlobStream(stored)) chunks.push(Buffer.from(part));
    bytes = Buffer.concat(chunks);
  }
  if (bytes.includes(0)) return { error: "Binary file — use the object download link." };
  try { return { content: new TextDecoder("utf-8", { fatal: true }).decode(bytes) }; }
  catch { return { error: "Not UTF-8 text — use the object download link." }; }
}

export default async function Browse({ params, searchParams }: {
  params: Promise<Params>; searchParams: Promise<Search>;
}) {
  const { id } = await params;
  const { actor, repository } = await repositoryWorkspace(id);
  const q = await searchParams;
  const path = q.path || "";
  if (!validRelativePath(path)) notFound();
  if (!q.revision) {
    const ref = await db.sourceReference.findUnique({where:{
      repositoryId_name:{repositoryId:id,name:repository.defaultBranch}
    }});
    if (!ref || ref.deletedAt) return <RepositoryNavigation id={id}
      label={repository.owner.handle+"/"+repository.slug} active="browse"
      title="Repository files" description="Canonical repository source browsing.">
      <section className="surface-card"><p className="repo-empty">No default reference exists yet.
        Publish or import an immutable changeset, then create the default branch.</p>
        <div className="repo-pagination"><Link href={repoHref(id,"source/import")}>Import repository</Link>
          <Link href={repoHref(id,"source")}>Reference management</Link></div></section>
    </RepositoryNavigation>;
  }
  const revision = await selectedRevision(id, q.revision || repository.defaultBranch, actor);
  const state = await getCanonicalSnapshot(id, revision, actor);
  const file = state.entries.find(entry => entry.path === path);
  if (file) {
    try { await assertRepositoryPermission(actor, id, "source:read", { paths: [path] }); } catch { notFound(); }
  } else if (path && !state.entries.some(entry => entry.path.startsWith(path + "/"))) notFound();
  const start = boundedNumber(q.start, 1, 1000000);
  const blame = q.view === "blame";
  const pageSize = 180;
  const fileData = file && !blame ? await readFileObject(file.objectId) : null;
  const blameData = file && blame ? await runAuthorizedQuery(actor, id, () => blameQuery(id, revision, path)) : null;
  const allLines = blameData ? blameData.lines.map(x => ({ number:x.line,text:x.text,changesetId:x.changesetId })) :
    fileData?.content !== undefined ? fileData.content.split("\n").map((text, i) => ({ number: i + 1, text })) : [];
  const totalLines = allLines.length;
  const visibleLines = allLines.slice(start - 1, start - 1 + pageSize);
  const prefix = path ? path + "/" : "";
  const available = new Map<string, { path: string; kind: "file" | "directory"; objectId?: string }>();
  if (!file) for (const entry of state.entries) {
    if (!entry.path.startsWith(prefix)) continue;
    const tail = entry.path.slice(prefix.length);
    const name = tail.split("/")[0];
    if (!name) continue;
    const childPath = prefix + name;
    const kind = tail.includes("/") ? "directory" : "file";
    if (kind === "directory" || !available.has(childPath)) available.set(childPath,
      { path: childPath, kind, objectId: kind === "file" ? entry.objectId : undefined });
  }
  const sorted = [...available.values()].sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const accessible: typeof sorted = [];
  for (const entry of sorted) {
    const probe = entry.kind === "file" ? [entry.path] :
      state.entries.filter(item => item.path.startsWith(entry.path + "/")).map(item => item.path);
    for (const candidate of probe) {
      try {
        await assertRepositoryPermission(actor, id, "source:read", { paths: [candidate] });
        accessible.push(entry); break;
      } catch { /* A restricted subtree must not be listed. */ }
    }
  }
  const cursor = q.cursor || "";
  const filtered = accessible.filter(entry => entry.path > cursor);
  const children = filtered.slice(0, 101);
  const nextCursor = children.length > 100 ? children[99].path : null;
  return <RepositoryNavigation id={id} label={repository.owner.handle + "/" + repository.slug}
    active="browse" title="Repository files" description="Canonical file contents and directory trees at a selected revision.">
    <div className="repo-toolbar repo-toolbar-top">
      <form method="get" className="repo-ref-picker"><label htmlFor="browse-ref">Revision</label><input id="browse-ref" name="revision" defaultValue={q.revision || repository.defaultBranch}/>
        {path && <input type="hidden" name="path" value={path}/>}<button type="submit">Go</button></form>
      <span className="repo-note">Snapshot <code>{revision.slice(0, 12)}</code></span>
    </div>
    <section className="surface-card repo-section">
      <div className="repo-toolbar"><div className="repo-crumbs"><Link href={repoHref(id, "browse", { revision })}>{repository.slug}</Link>
        {path.split("/").filter(Boolean).map((part, i, arr) => <span key={i}><span aria-hidden="true">/</span>
          <Link href={repoHref(id,"browse",{path:arr.slice(0,i+1).join("/"),revision})}>{part}</Link></span>)}</div>
        {file && <div className="repo-inline-actions"><Link href={repoHref(id,"history",{path,revision})}>File history</Link>
          <Link aria-current={blame ? "page" : undefined} href={repoHref(id,"browse",{path,revision,view:blame ? undefined:"blame"})}>{blame ? "View file" : "Blame"}</Link>
          <a href={"/api/v2/repositories/"+id+"/objects/"+file.objectId+"/content?path="+encodeURIComponent(path)+"&revision="+revision} download={path.split("/").pop()}>Download</a></div>}
      </div>
      {file ? <>
        {fileData?.error && <p className="repo-empty" role="status">{fileData.error}</p>}
        {blameData?.truncated && <p className="repo-note repo-note-padded">Blame history is truncated to the available first-parent window.</p>}
        {visibleLines.length > 0 && <SourceCodeTable id={id} path={path} revision={revision} lines={visibleLines} blame={blame}/>}
        {totalLines > pageSize && <div className="repo-pagination">
          {start > 1 && <Link href={repoHref(id,"browse",{path,revision,start:Math.max(1,start-pageSize),view:blame?"blame":undefined})}>Previous lines</Link>}
          {start + pageSize <= totalLines && <Link href={repoHref(id,"browse",{path,revision,start:start+pageSize,view:blame?"blame":undefined})}>Next lines</Link>}
          <span>Lines {start}–{Math.min(totalLines,start+pageSize-1)} of {totalLines}</span>
        </div>}
      </> : children.length ? <>
        <div className="table-scroll"><table className="data-table repo-table"><thead><tr><th>NAME</th><th>TYPE</th><th>OBJECT</th></tr></thead>
          <tbody>{children.slice(0,100).map(entry => <tr key={entry.path}><td><Link className="row-title"
            href={repoHref(id,"browse",{path:entry.path,revision})}>{entry.path.slice(prefix.length)}</Link></td>
            <td>{entry.kind}</td><td><code>{entry.objectId?.slice(0,12) || "—"}</code></td></tr>)}</tbody>
        </table></div>
        <div className="repo-pagination">{q.cursor && <Link href={repoHref(id,"browse",{path,revision})}>First page</Link>}
          {nextCursor && <Link href={repoHref(id,"browse",{path,revision,cursor:nextCursor})}>Next files</Link>}</div>
      </> : <p className="repo-empty">No readable files at this revision.</p>}
    </section>
  </RepositoryNavigation>;
}

"use client";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

type Change = { id: string; message: string; approved: boolean; validation: string };
type Ref = { name: string; generation: number; changesetId: string; deleted: boolean; kind: string };
export default function SourceControls({ repositoryId, changesets, refs, defaultBranch }: {
  repositoryId: string; changesets: Change[]; refs: Ref[]; defaultBranch: string;
}) {
  const router = useRouter();
  const [changeId, setChangeId] = useState(changesets[0]?.id ?? "");
  const [referenceName, setReferenceName] = useState(refs[0]?.name ?? defaultBranch);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const selected = useMemo(() => changesets.find(c => c.id === changeId), [changesets, changeId]);
  const ref = refs.find(r => r.name === referenceName);
  const blocked = referenceName === defaultBranch || ref?.kind === "TAG";
  const root = `/api/v1/repositories/${repositoryId}`;
  const refUrl = `${root}/refs/${referenceName.split("/").map(encodeURIComponent).join("/")}`;
  const send = async (url: string, method: "POST" | "PUT" | "DELETE", body?: unknown, successful = "Saved.") => {
    setBusy(true); setMessage("");
    try {
      const response = await fetch(url, { method, credentials: "same-origin",
        headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      const value = await response.json();
      if (!response.ok) throw new Error(value.message ?? value.error ?? `HTTP ${response.status}`);
      setMessage(successful);
      router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Request failed"); }
    finally { setBusy(false); }
  };
  const update = () => send(ref?.deleted ? `${root}/refs` : refUrl, ref?.deleted ? "POST" : "PUT",
    { ...(ref?.deleted ? { name: referenceName } : {}), changesetId: changeId,
      expectedGeneration: ref?.generation ?? null, expectedChangesetId: ref?.changesetId,
      mutationId: crypto.randomUUID() }, ref?.deleted ? "Reference restored." : "Reference updated.");
  return <div className="source-controls">
    <label htmlFor="source-change">Changeset</label>
    <select id="source-change" value={changeId} onChange={e => setChangeId(e.target.value)} disabled={busy || !changesets.length}>
      {changesets.map(c => <option key={c.id} value={c.id}>{c.message.slice(0, 45)} · {c.id.slice(0, 9)}</option>)}
    </select>
    <p className="source-muted">Verification: {selected?.validation ?? "None"} · Owner approval: {selected?.approved ? "Recorded" : "Required"}</p>
    <button type="button" className="source-action" disabled={busy || !selected || selected.approved || selected.validation !== "SUCCESS"}
      onClick={() => void send(`${root}/changesets/${changeId}/approve`, "POST", undefined, "Approval saved.")}>Approve changeset</button>
    <div className="source-rule"/>
    <label htmlFor="source-ref">Reference name</label>
    <input id="source-ref" value={referenceName} maxLength={200} onChange={e => setReferenceName(e.target.value)} disabled={busy}/>
    <p className="source-muted">{ref ?
      `${ref.kind.toLowerCase()} · generation ${ref.generation}${ref.deleted ? " · deleted (restore required)" : ""}` :
      "New branch, release pointer or tag · create-only"}
      {referenceName === defaultBranch ? " · protected default" : ""}
    </p>
    <button type="button" className="source-action secondary"
      disabled={busy || !selected?.approved || !referenceName || (ref?.kind === "TAG")}
      onClick={() => void update()}>{ref?.deleted ? "Restore reference" : ref ? "Move reference" : "Create reference"}</button>
    {ref && !ref.deleted && !blocked && <button type="button" className="source-action secondary"
      disabled={busy} onClick={() => void send(refUrl, "DELETE",
        { expectedGeneration: ref.generation, expectedChangesetId: ref.changesetId, mutationId: crypto.randomUUID() },
        "Reference deleted; generation retained for restore.")}>Delete reference</button>}
    {ref?.kind === "TAG" && <p className="source-muted">Tags are immutable once created.</p>}
    {message && <p role="status" className="source-result">{message}</p>}
  </div>;
}

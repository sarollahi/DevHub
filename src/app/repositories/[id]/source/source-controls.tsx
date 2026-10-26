"use client";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

type Change = { id: string; message: string; approved: boolean; validation: string };
type Ref = { name: string; generation: number; changesetId: string };
export default function SourceControls({ repositoryId, changesets, refs }: { repositoryId: string; changesets: Change[]; refs: Ref[] }) {
  const router = useRouter();
  const [changeId, setChangeId] = useState(changesets[0]?.id ?? "");
  const [referenceName, setReferenceName] = useState(refs[0]?.name ?? "main");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const selected = useMemo(() => changesets.find(c => c.id === changeId), [changesets, changeId]);
  const ref = refs.find(r => r.name === referenceName);
  const root = `/api/v1/repositories/${repositoryId}`;
  const send = async (url: string, method: "POST" | "PUT", body?: unknown) => {
    setBusy(true); setMessage("");
    try {
      const response = await fetch(url, { method, credentials: "same-origin",
        headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
      const value = await response.json();
      if (!response.ok) throw new Error(value.message ?? value.error ?? `HTTP ${response.status}`);
      setMessage(method === "POST" ? "Approval saved." : "Reference updated.");
      router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Request failed"); }
    finally { setBusy(false); }
  };
  return <div className="source-controls">
    <label htmlFor="source-change">Changeset</label>
    <select id="source-change" value={changeId} onChange={e => setChangeId(e.target.value)} disabled={busy || !changesets.length}>
      {changesets.map(c => <option key={c.id} value={c.id}>{c.message.slice(0, 45)} · {c.id.slice(0, 9)}</option>)}
    </select>
    <p className="source-muted">Verification: {selected?.validation ?? "None"} · Owner approval: {selected?.approved ? "Recorded" : "Required"}</p>
    <button type="button" className="source-action" disabled={busy || !selected || selected.approved || selected.validation !== "SUCCESS"}
      onClick={() => void send(`${root}/changesets/${changeId}/approve`, "POST")}>Approve changeset</button>
    <div className="source-rule"/>
    <label htmlFor="source-ref">Reference name</label>
    <input id="source-ref" value={referenceName} maxLength={200} onChange={e => setReferenceName(e.target.value)} disabled={busy}/>
    <p className="source-muted">{ref ? `Existing reference · generation ${ref.generation}` : "New reference · must not exist"}</p>
    <button type="button" className="source-action secondary" disabled={busy || !selected?.approved || !referenceName}
      onClick={() => void send(`${root}/refs/${referenceName.split("/").map(encodeURIComponent).join("/")}`, "PUT",
        { changesetId: changeId, expectedGeneration: ref?.generation ?? null })}>Update reference</button>
    {message && <p role="status" className="source-result">{message}</p>}
  </div>;
}

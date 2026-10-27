"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
export default function ReviewActions({ repositoryId, changesetId, ready, state }: {
  repositoryId: string; changesetId: string; ready: boolean; state: string;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const router = useRouter();
  async function send(path: string, body?: unknown) {
    setBusy(true); setMessage(null);
    try {
      const result = await fetch(path, { method: "POST", headers: { "content-type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      const payload = await result.json() as { message?: string; error?: string };
      if (!result.ok) throw new Error(payload.message || payload.error || "Request rejected");
      setMessage("Decision saved to the audit log.");
      router.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "Operation failed"); }
    finally { setBusy(false); }
  }
  const endpoint = "/api/v2/repositories/"+repositoryId+"/changesets/"+changesetId+"/review";
  return <div className="review-actions">
    {state === "FAILED" && <button disabled={busy} className="tertiary-button" onClick={()=>send(endpoint+"/retry")}>Retry analysis</button>}
    <button disabled={busy || !ready} className="primary-button" onClick={()=>send(endpoint,{
      expectedChangesetId: changesetId, decision: "APPROVED" })}>Approve this revision</button>
    <button disabled={busy} className="tertiary-button" onClick={()=>send(endpoint,{
      expectedChangesetId: changesetId, decision: "CHANGES_REQUESTED" })}>Request changes</button>
    {message && <p role="status" className="review-action-status">{message}</p>}
  </div>;
}

"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
export default function ApproveButton({ id }: { id: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();
  async function approve() {
    setPending(true); setError("");
    try {
      const res = await fetch(`/api/v1/pull-requests/${id}/approve`, { method: "POST", credentials: "same-origin" });
      if (!res.ok) throw new Error(`Approval declined (${res.status})`);
      router.refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Approval failed"); }
    finally { setPending(false); }
  }
  return <><button disabled={pending} className="primary-button" onClick={approve}>{pending ? "Saving decision…" : "Approve this change"}</button>{error && <p className="error">{error}</p>}</>;
}

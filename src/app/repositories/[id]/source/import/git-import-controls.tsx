"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

type Job = { id: string; sourcePath: string; status: string; imported: number;
  lastGitSha: string | null; lastError: string | null; verifiedAt: string | null };
export default function GitImportControls({ repositoryId, initialJobs }: {
  repositoryId: string; initialJobs: Job[];
}) {
  const router = useRouter();
  const [sourcePath, setSourcePath] = useState("");
  const [jobs, setJobs] = useState(initialJobs);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const base = `/api/v2/repositories/${repositoryId}/imports`;
  async function send(url: string, payload: unknown) {
    setBusy(true); setNotice("");
    try {
      const response = await fetch(url, { method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message || body.error || `HTTP ${response.status}`);
      setNotice("Job queued. A running import worker will process it.");
      await refresh();
    } catch (error) { setNotice(error instanceof Error ? error.message : "Request failed"); }
    finally { setBusy(false); }
  }
  async function refresh() {
    const response = await fetch(base, { cache: "no-store" });
    if (!response.ok) throw new Error("Could not read import status");
    const body = await response.json();
    setJobs(body.jobs.map((job: Job & { verifiedAt?: string }) => job));
    router.refresh();
  }
  return <div className="source-controls">
    <label htmlFor="import-directory">Git directory (under GIT_IMPORT_ROOT)</label>
    <input id="import-directory" value={sourcePath} onChange={event => setSourcePath(event.target.value)}
      maxLength={1024} placeholder="team/project.git" disabled={busy}/>
    <p className="source-muted">The server requires a configured import root. Remote URLs and filesystem paths outside it are rejected.</p>
    <button type="button" className="source-action" disabled={busy || !sourcePath.trim()}
      onClick={() => void send(base, { sourcePath })}>Queue import</button>
    <button type="button" className="source-action secondary" disabled={busy}
      onClick={() => void refresh().catch(error => setNotice(error.message))}>Refresh status</button>
    {notice && <p className="source-result" role="status">{notice}</p>}
    {jobs.length ? <div className="table-scroll"><table className="data-table">
      <thead><tr><th>Source</th><th>Status</th><th>Commits</th><th>Verification</th><th>Actions</th></tr></thead>
      <tbody>{jobs.map(job => <tr key={job.id}>
        <td><strong>{job.sourcePath}</strong><small className="source-subline">{job.lastGitSha?.slice(0, 12) || "Not started"}</small>
          {job.lastError && <p role="alert">{job.lastError}</p>}</td>
        <td>{job.status}</td><td>{job.imported}</td>
        <td>{job.verifiedAt ? new Date(job.verifiedAt).toLocaleString() : "Not verified"}</td>
        <td><button type="button" className="source-action secondary" disabled={busy || job.status === "RUNNING" || job.status === "VERIFYING"}
          onClick={() => void send(`${base}/${job.id}`, { action: "resume" })}>Resume / sync</button>
          <button type="button" className="source-action secondary" disabled={busy || job.status === "RUNNING" || job.status === "VERIFYING"}
          onClick={() => void send(`${base}/${job.id}`, { action: "verify" })}>Verify</button></td>
      </tr>)}</tbody>
    </table></div> : <p className="source-empty">No migrations started.</p>}
  </div>;
}

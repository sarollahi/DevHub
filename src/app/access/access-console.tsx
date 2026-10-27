"use client";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

type Org = { id: string; name: string; role: string };
type Repo = { id: string; name: string; slug: string; organizationId: string | null };
type Machine = { id: string; name: string; scopes: string[]; status: string };
type Tab = "members" | "machines" | "policies";

export default function AccessConsole({ organizations, repositories, machines }: {
  organizations: Org[]; repositories: Repo[]; machines: Machine[];
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("members");
  const [organizationId, setOrganizationId] = useState(organizations[0]?.id ?? "");
  const [repositoryId, setRepositoryId] = useState(repositories[0]?.id ?? "");
  const [machineId, setMachineId] = useState(machines[0]?.id ?? "");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState("");
  const [scope, setScope] = useState("source:read");

  async function submit(event: FormEvent<HTMLFormElement>, endpoint: string, success: string) {
    event.preventDefault();
    setBusy(true); setStatus(""); setToken("");
    const form = new FormData(event.currentTarget);
    const fields = Object.fromEntries(form.entries());
    const data: Record<string, unknown> = { ...fields };
    if ("scopes" in fields) data.scopes = [String(fields.scopes)];
    if ("ttlMinutes" in fields) data.ttlMinutes = Number(fields.ttlMinutes);
    if ("ttlHours" in fields) data.ttlHours = Number(fields.ttlHours);
    if ("revokePrevious" in fields) data.revokePrevious = fields.revokePrevious === "true";
    if ("branch" in fields && !fields.branch) delete data.branch;
    if ("pathPrefix" in fields && !fields.pathPrefix) delete data.pathPrefix;
    try {
      const response = await fetch(endpoint, { method: "POST", credentials: "same-origin",
        headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? result.error ?? "Request rejected");
      if (typeof result.token === "string") setToken(result.token);
      setStatus(success);
      if (!(result.token)) router.refresh();
    } catch (error) { setStatus(error instanceof Error ? error.message : "Request failed"); }
    finally { setBusy(false); }
  }

  const chosenOrganization = organizations.find(o => o.id === organizationId);
  const canAdmin = chosenOrganization?.role === "OWNER" || chosenOrganization?.role === "ADMIN";
  const chosenRepo = repositories.find(r => r.id === repositoryId);
  return <div className="access-console">
    <div className="access-overview">
      <div><span>Organizations</span><strong>{organizations.length}</strong></div>
      <div><span>Accessible repositories</span><strong>{repositories.length}</strong></div>
      <div><span>Machine identities</span><strong>{machines.length}</strong></div>
    </div>
    <section className="access-panel">
      <div className="access-heading"><div><h2>Identity administration</h2><p>Policies are enforced by the database-backed source-control services.</p></div></div>
      <div className="access-tabs" role="tablist" aria-label="Security settings">
        {([["members","People & teams"],["machines","Machine credentials"],["policies","Repository policies"]] as const).map(([id,label]) =>
          <button type="button" key={id} role="tab" aria-selected={tab===id}
            className={tab===id ? "selected" : ""} onClick={()=>{setTab(id);setStatus("");setToken("");}}>{label}</button>)}
      </div>
      {tab === "members" && <div className="access-panels">
        <div className="access-pane"><h3>Organization</h3>
          <label htmlFor="org-choice">Current organization</label>
          <select id="org-choice" value={organizationId} onChange={e=>setOrganizationId(e.target.value)}>
            {organizations.map(o=><option key={o.id} value={o.id}>{o.name} · {o.role.toLowerCase()}</option>)}
          </select>
          <p className="access-hint">Only an owner or administrator can provision accounts or change memberships.</p>
          <h3>Provision a person</h3>
          <form onSubmit={e=>void submit(e,`/api/v1/organizations/${organizationId}/users`,"Account and membership created.")}>
            <label htmlFor="user-handle">Username</label><input id="user-handle" name="handle" minLength={3} required placeholder="jane-smith"/>
            <label htmlFor="user-email">Work email</label><input id="user-email" name="email" type="email" required placeholder="jane@example.com"/>
            <label htmlFor="user-password">Initial password</label><input id="user-password" name="password" type="password" minLength={12} autoComplete="new-password" required/>
            <label htmlFor="user-role">Role</label><select id="user-role" name="role"><option value="MEMBER">Member</option><option value="ADMIN">Administrator</option></select>
            <button type="submit" disabled={busy||!canAdmin}>Create account</button>
          </form>
        </div>
        <div className="access-pane"><h3>Teams</h3>
          <p className="access-hint">Teams group human members. Assign permissions per repository; membership alone does not grant source access.</p>
          <form onSubmit={e=>void submit(e,`/api/v1/organizations/${organizationId}/teams`,"Team created.")}>
            <label htmlFor="team-name">Team name</label><input id="team-name" name="name" required placeholder="Platform engineering"/>
            <label htmlFor="team-slug">Team slug</label><input id="team-slug" name="slug" pattern="[a-z0-9-]+" required placeholder="platform-engineering"/>
            <button type="submit" disabled={busy||!canAdmin}>Create team</button>
          </form>
          <div className="access-guidance"><strong>Approval integrity</strong>
            <p>Human review and protected branch policy are evaluated in server transactions. Automated review output is never an approval credential.</p>
          </div>
        </div>
      </div>}
      {tab === "machines" && <div className="access-panels">
        <div className="access-pane"><h3>Create a machine identity</h3>
          <form onSubmit={e=>void submit(e,"/api/v1/machines","Machine identity created. Issue a credential separately.")}>
            <label htmlFor="machine-name">Name</label><input id="machine-name" name="name" minLength={2} required placeholder="ci-builder"/>
            <label htmlFor="machine-scopes">Maximum capability</label>
            <select id="machine-scopes" name="scopes"><option value="source:read">Read source</option><option value="changeset:write">Publish changesets</option><option value="ref:update">Update refs</option></select>
            <button type="submit" disabled={busy}>Create machine</button>
          </form>
          <h3>Issue or rotate credential</h3>
          <form onSubmit={e=>void submit(e,`/api/v1/machines/${machineId}/credentials`,"Credential issued. Copy it now; it is displayed only once.")}>
            <label htmlFor="machine-choice">Identity</label><select id="machine-choice" value={machineId} onChange={e=>setMachineId(e.target.value)}>
              {machines.map(m=><option key={m.id} value={m.id}>{m.name} · {m.status.toLowerCase()}</option>)}
            </select>
            <label htmlFor="credential-label">Credential label</label><input id="credential-label" name="label" placeholder="developer-laptop" required/>
            <label htmlFor="credential-scope">Credential capability</label><select id="credential-scope" name="scopes">{["source:read","changeset:write","ref:update"].map(c=><option key={c} value={c}>{c}</option>)}</select>
            <label htmlFor="credential-ttl">Expiration</label><select id="credential-ttl" name="ttlMinutes"><option value="15">15 minutes</option><option value="30">30 minutes</option><option value="60">60 minutes</option></select>
            <label htmlFor="rotate">Rotation behavior</label><select id="rotate" name="revokePrevious"><option value="false">Keep existing until expiry</option><option value="true">Revoke all existing credentials</option></select>
            <button type="submit" disabled={busy||!machineId}>Issue credential</button>
          </form>
        </div>
        <div className="access-pane"><h3>Delegate repository access</h3>
          <form onSubmit={e=>void submit(e,`/api/v1/repositories/${repositoryId}/delegations`,"Delegation created.")}>
            <label htmlFor="delegation-repo">Repository</label><select id="delegation-repo" value={repositoryId} onChange={e=>setRepositoryId(e.target.value)}>
              {repositories.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}</select>
            <label htmlFor="delegation-agent">Machine</label><select id="delegation-agent" name="agentId" defaultValue={machineId}>{machines.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select>
            <label htmlFor="delegation-cap">Granted capability</label><select id="delegation-cap" name="scopes"><option value="source:read">Read source</option><option value="changeset:write">Publish changesets</option><option value="ref:update">Update refs</option></select>
            <label htmlFor="delegation-branch">Branch restriction (optional)</label><input id="delegation-branch" name="branch" placeholder="develop"/>
            <label htmlFor="delegation-path">Path restriction (optional)</label><input id="delegation-path" name="pathPrefix" placeholder="src/mobile"/>
            <label htmlFor="delegation-ttl">Delegation lifetime</label><select id="delegation-ttl" name="ttlHours"><option value="1">1 hour</option><option value="8">8 hours</option><option value="24">24 hours</option></select>
            <button type="submit" disabled={busy||!repositoryId||!machineId}>Grant delegation</button>
          </form>
          <p className="access-hint">A credential and an active delegation are both required. A credential cannot exceed its identity's maximum capabilities.</p>
        </div>
      </div>}
      {tab === "policies" && <div className="access-panels">
        <div className="access-pane"><h3>Repository permissions</h3>
          <label htmlFor="policy-repo">Repository</label><select id="policy-repo" value={repositoryId} onChange={e=>setRepositoryId(e.target.value)}>{repositories.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}</select>
          <form onSubmit={e=>void submit(e,`/api/v1/repositories/${repositoryId}/access`,"Repository policy created.")}>
            <label htmlFor="subject-kind">Principal type</label><select id="subject-kind" name="subjectType"><option value="USER">User</option><option value="TEAM">Team</option><option value="AGENT">Machine</option></select>
            <label htmlFor="subject-id">Principal identifier</label><input id="subject-id" name="subjectId" required placeholder="UUID"/>
            <label htmlFor="policy-operation">Capability</label><select id="policy-operation" name="capability"><option value="source:read">Read source</option><option value="changeset:write">Publish changesets</option><option value="ref:update">Update refs</option><option value="review">Human review</option><option value="admin">Administration</option></select>
            <label htmlFor="policy-effect">Policy effect</label><select id="policy-effect" name="effect"><option value="ALLOW">Allow</option><option value="DENY">Deny</option></select>
            <label htmlFor="policy-path">Directory restriction (optional)</label><input id="policy-path" name="pathPrefix" placeholder="src/mobile"/>
            <label htmlFor="policy-branch">Branch restriction (optional)</label><input id="policy-branch" name="branch" placeholder="develop"/>
            <button type="submit" disabled={busy||!repositoryId}>Save policy</button>
          </form>
        </div>
        <div className="access-pane"><h3>Effective-access rules</h3><div className="access-guidance">
          <strong>Explicit denials take precedence</strong><p>Grants may be restricted to a branch or directory. Out-of-tenant principals cannot be added.</p>
          <strong>Separation of duties</strong><p>Source reads, changeset publication, ref updates, review and administration are independent capabilities.</p>
          <strong>Audit trail</strong><p>Identity, policy, and source mutations write persistent audit events. Sensitive credentials are never returned after initial issuance.</p>
        </div>{chosenRepo && <p className="access-hint">Current repository: {chosenRepo.name} ({chosenRepo.slug})</p>}</div>
      </div>}
      {status && <p className="access-status" role="status">{status}</p>}
      {token && <div className="access-secret"><strong>New credential · shown once</strong><code>{token}</code>
        <button type="button" onClick={()=>void navigator.clipboard.writeText(token)}>Copy credential</button></div>}
    </section>
  </div>;
}

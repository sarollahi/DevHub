import { redirect } from "next/navigation";
import { isAdminRequest } from "@/lib/auth";
import { db } from "@/lib/prisma";
import WorkspaceShell from "@/components/workspace-shell";
import Icon from "@/components/icons";
import { StateBadge } from "@/components/status";
export const dynamic = "force-dynamic";
export default async function AgentsPage() {
  if (!(await isAdminRequest())) redirect("/login");
  const agents = await db.agentIdentity.findMany({ orderBy:{createdAt:"desc"},include:{owner:{select:{handle:true}},_count:{select:{pullRequests:true,credentials:true}}} });
  return <WorkspaceShell active="/agents" title="Agents" description="Identify machine contributors and audit their assigned scopes."><section className="surface-card directory-card"><div className="directory-heading"><strong>{agents.length} machine identities</strong><span>Credentials are scoped, hashed, and revocable.</span></div>{agents.length ? <div className="table-scroll"><table className="data-table"><thead><tr><th>IDENTITY</th><th>OWNER</th><th>SCOPES</th><th>CREDENTIALS</th><th>CONTRIBUTIONS</th><th>STATUS</th></tr></thead><tbody>{agents.map(agent=><tr key={agent.id}><td><div className="agent-cell"><span className="agent-avatar"><Icon name="bot" size={16}/></span><strong>{agent.name}</strong></div></td><td>{agent.owner.handle}</td><td>{agent.scopes.map(scope=><span className="scope-chip" key={scope}>{scope}</span>)}</td><td>{agent._count.credentials}</td><td>{agent._count.pullRequests}</td><td><StateBadge state={agent.status==="ACTIVE"?"SUCCESS":agent.status==="REVOKED"?"BLOCKED":"PENDING"}/></td></tr>)}</tbody></table></div> : <div className="table-empty"><div className="table-empty-icon"><Icon name="bot" size={22}/></div><strong>No agents registered</strong><p>Run the seed command to create a scoped machine identity.</p><code>npm run db:seed</code></div>}</section><div className="info-bar"><Icon name="shield" size={18}/><span>Machine credentials cannot create human approvals. Review decisions remain under human control.</span></div></WorkspaceShell>;
}

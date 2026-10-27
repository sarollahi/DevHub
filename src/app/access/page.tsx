import { redirect } from "next/navigation";
import { db } from "@/lib/prisma";
import { sessionIdentity } from "@/lib/auth";
import { permittedRepositoryIds } from "@/lib/tenant";
import WorkspaceShell from "@/components/workspace-shell";
import AccessConsole from "./access-console";
import "./access.css";

export const dynamic = "force-dynamic";
export default async function AccessPage() {
  const actor = await sessionIdentity();
  if (!actor) redirect("/login");
  const permitted = await permittedRepositoryIds(actor);
  const [memberships, repositories, machines] = await Promise.all([
    db.organizationMembership.findMany({ where: { userId: actor.id }, include: {
      organization: { select: { id: true, name: true, slug: true } },
    } }),
    db.repository.findMany({ where: { id: { in: permitted } }, select: {
      id: true, name: true, slug: true, organizationId: true,
    } }),
    db.agentIdentity.findMany({ where: { ownerId: actor.id }, select: { id: true, name: true, scopes: true, status: true } }),
  ]);
  return <WorkspaceShell active="/access" title="Access & security"
    description="Manage tenant membership, machine credentials, and repository policy from one workspace.">
    <AccessConsole organizations={memberships.map(m => ({
      id: m.organization.id, name: m.organization.name, role: m.role,
    }))} repositories={repositories} machines={machines}/>
  </WorkspaceShell>;
}

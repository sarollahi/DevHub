import { db } from "./prisma";
import { sessionIdentity, verifyBrowserOrigin } from "./auth";
import { SourceControlError, type SourceActor } from "../source-control/contracts";
import { type Prisma } from "@prisma/client";

type Tx = Prisma.TransactionClient;
export async function requireHuman(request: Request, mutation = false): Promise<SourceActor> {
  const actor = await sessionIdentity(request);
  if (!actor) throw new SourceControlError(401, "UNAUTHORIZED", "Human session required");
  if (mutation && !verifyBrowserOrigin(request)) {
    throw new SourceControlError(403, "INVALID_ORIGIN", "Invalid browser origin");
  }
  return actor;
}
export async function requireMembership(userId: string, organizationId: string, tx: Tx = db) {
  const membership = await tx.organizationMembership.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
  });
  if (!membership) throw new SourceControlError(404, "NOT_FOUND", "Organization not found");
  return membership;
}
export async function requireOrgAdministrator(userId: string, organizationId: string, tx: Tx = db) {
  const membership = await requireMembership(userId, organizationId, tx);
  if (membership.role !== "OWNER" && membership.role !== "ADMIN") {
    throw new SourceControlError(403, "ADMIN_REQUIRED", "Organization administrator permission required");
  }
  return membership;
}
export async function assertRepoAdmin(userId: string, repositoryId: string, tx: Tx = db) {
  const repo = await tx.repository.findUnique({
    where: { id: repositoryId }, select: { ownerId: true, organizationId: true },
  });
  if (!repo) throw new SourceControlError(404, "NOT_FOUND", "Repository not found");
  if (repo.organizationId) await requireOrgAdministrator(userId, repo.organizationId, tx);
  else if (repo.ownerId !== userId) throw new SourceControlError(404, "NOT_FOUND", "Repository not found");
  return repo;
}
export async function auditIdentity(tx: Tx, actorId: string, action: string, subjectId: string,
  repositoryId?: string, metadata?: object) {
  await tx.auditEvent.create({ data: {
    actorType: "HUMAN", actorId, action, subjectId,
    ...(repositoryId ? { repositoryId } : {}),
    ...(metadata ? { metadata } : {}),
  } });
}

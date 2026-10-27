import { Prisma, type GrantEffect, type GrantSubject } from "@prisma/client";
import { db } from "./prisma";
import { validPath } from "./review-logic";
import { SourceControlError, type SourceActor } from "../source-control/contracts";

export type Capability = "source:read" | "changeset:write" | "ref:update" | "review" | "admin";
export type AccessTarget = { paths?: string[]; branch?: string; allowStaging?: boolean };
type Database = Prisma.TransactionClient;

const scopeAliases: Record<string, Capability> = {
  "changesets:read": "source:read", "source:read": "source:read",
  "changesets:write": "changeset:write", "pull_requests:write": "changeset:write",
  "changeset:write": "changeset:write", "refs:write": "ref:update",
  "ref:update": "ref:update", "changesets:approve": "review",
  review: "review", admin: "admin",
};
export function canonicalCapability(scope: string): Capability {
  const result = scopeAliases[scope];
  if (!result) throw new SourceControlError(403, "UNKNOWN_CAPABILITY", "Unrecognized operation");
  return result;
}
const permits = (scopes: string[], capability: Capability) =>
  scopes.some(scope => scopeAliases[scope] === capability || (scope === "admin" && capability !== "review"));

const matchesBranch = (restriction: string | null, branch?: string) =>
  restriction === null || (!!branch && (restriction === branch ||
    (restriction.endsWith("/*") && branch.startsWith(restriction.slice(0, -1)))));
const matchesPath = (restriction: string | null, paths: string[] | undefined, allowStaging: boolean) => {
  if (restriction === null) return true;
  if (!paths || paths.length === 0) return allowStaging;
  return paths.every(path => path === restriction || path.startsWith(restriction + "/"));
};
const appliesToAny = (restriction: string | null, paths: string[] | undefined) =>
  restriction === null || !paths || paths.some(path => path === restriction || path.startsWith(restriction + "/"));

export async function assertRepositoryPermission(
  actor: SourceActor, repositoryId: string, capability: Capability,
  target: AccessTarget = {}, tx: Database = db,
): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(repositoryId)) throw new SourceControlError(404, "NOT_FOUND", "Repository not found");
  if (target.paths?.some(path => !validPath(path))) throw new SourceControlError(422, "INVALID_PATH", "Invalid repository path");
  const repo = await tx.repository.findUnique({ where: { id: repositoryId }, select: {
    id: true, ownerId: true, organizationId: true,
  } });
  if (!repo) throw new SourceControlError(404, "NOT_FOUND", "Repository not found");
  const now = new Date();
  let subjectIds: { subjectType: GrantSubject; subjectId: string }[] = [];
  let elevated = false;

  if (actor.type === "HUMAN") {
    if (!actor.sessionId) throw new SourceControlError(401, "UNAUTHORIZED", "Human session required");
    const session = await tx.humanSession.findUnique({ where: { id: actor.sessionId },
      include: { user: { select: { disabledAt: true } } } });
    if (!session || session.userId !== actor.id || session.revokedAt || session.expiresAt <= now || session.user.disabledAt) {
      throw new SourceControlError(401, "SESSION_EXPIRED", "Session expired or revoked");
    }
    const membership = repo.organizationId ? await tx.organizationMembership.findUnique({
      where: { organizationId_userId: { organizationId: repo.organizationId, userId: actor.id } },
    }) : null;
    if (repo.organizationId && !membership) throw new SourceControlError(404, "NOT_FOUND", "Repository not found");
    elevated = repo.ownerId === actor.id || membership?.role === "OWNER" || membership?.role === "ADMIN";
    const teams = repo.organizationId ? await tx.teamMembership.findMany({
      where: { userId: actor.id, team: { organizationId: repo.organizationId } }, select: { teamId: true },
    }) : [];
    subjectIds = [{ subjectType: "USER", subjectId: actor.id },
      ...teams.map(team => ({ subjectType: "TEAM" as const, subjectId: team.teamId }))];
  } else if (actor.type === "AGENT") {
    if (!actor.credentialId) throw new SourceControlError(401, "UNAUTHORIZED", "Agent credential required");
    const credential = await tx.agentCredential.findUnique({
      where: { id: actor.credentialId }, include: { agent: true },
    });
    if (!credential || credential.agentId !== actor.id || credential.revokedAt || !credential.expiresAt ||
      credential.expiresAt <= now || credential.agent.status !== "ACTIVE") {
      throw new SourceControlError(401, "CREDENTIAL_REVOKED", "Credential expired or revoked");
    }
    if (capability === "review" || capability === "admin") {
      throw new SourceControlError(403, "HUMAN_REQUIRED", "A human is required for this operation");
    }
    if (!permits(credential.scopes, capability) || !permits(credential.agent.scopes, capability)) {
      throw new SourceControlError(403, "INSUFFICIENT_SCOPE", "Credential lacks requested scope");
    }
    const delegations = await tx.agentDelegation.findMany({
      where: { agentId: actor.id, repositoryId, revokedAt: null, expiresAt: { gt: now } },
    });
    let permitted = false;
    for (const delegation of delegations) {
      if (!permits(delegation.scopes, capability) ||
        !matchesBranch(delegation.branch, target.branch) ||
        !matchesPath(delegation.pathPrefix, target.paths, !!target.allowStaging)) continue;
      const permittedDelegator = delegation.delegatedBy === repo.ownerId ||
        (!!repo.organizationId && !!(await tx.organizationMembership.findFirst({
          where: { organizationId: repo.organizationId, userId: delegation.delegatedBy,
            role: { in: ["OWNER", "ADMIN"] } }, select: { userId: true },
        })));
      if (permittedDelegator) { permitted = true; break; }
    }
    if (!permitted) throw new SourceControlError(403, "DELEGATION_REQUIRED", "No current delegation covers this operation");
    subjectIds = [{ subjectType: "AGENT", subjectId: actor.id }];
    elevated = true; // Agent delegation is the allow rule; explicit DENY still applies.
  } else {
    throw new SourceControlError(401, "UNAUTHORIZED", "Unknown identity");
  }

  const grants = await tx.repositoryGrant.findMany({
    where: { repositoryId, OR: subjectIds.map(subject => ({
      subjectType: subject.subjectType, subjectId: subject.subjectId,
    })), capability: { in: [capability, "admin"] } },
  });
  // Deliberately evaluate denies before role-based grants.
  const relevant = grants.filter(grant => (!grant.expiresAt || grant.expiresAt > now) &&
    matchesBranch(grant.branch, target.branch));
  if (relevant.some(grant => grant.effect === "DENY" && appliesToAny(grant.pathPrefix, target.paths))) {
    throw new SourceControlError(403, "POLICY_DENIED", "A repository policy denies this operation");
  }
  if (elevated) return;
  if (!relevant.some(grant => grant.effect === "ALLOW" &&
    matchesPath(grant.pathPrefix, target.paths, !!target.allowStaging))) {
    throw new SourceControlError(403, "ACCESS_DENIED", "Repository access denied");
  }
}

export async function consumeRequestQuota(repositoryId: string, actor: SourceActor) {
  const repo = await db.repository.findUnique({ where: { id: repositoryId },
    select: { organization: { select: { maxRequestsPerMinute: true } } } });
  if (!repo) throw new SourceControlError(404, "NOT_FOUND", "Repository not found");
  const limit = Math.min(10000, Math.max(1, repo.organization?.maxRequestsPerMinute ?? 240));
  const now = new Date();
  const windowStart = new Date(Math.floor(now.getTime() / 60000) * 60000);
  const bucket = await db.apiRateBucket.upsert({
    where: { repositoryId_actorKey_windowStart: { repositoryId, actorKey: `${actor.type}:${actor.id}`, windowStart } },
    create: { repositoryId, actorKey: `${actor.type}:${actor.id}`, windowStart, count: 1 },
    update: { count: { increment: 1 } },
  });
  if (bucket.count > limit) throw new SourceControlError(429, "RATE_LIMITED", "Tenant request quota exceeded");
}

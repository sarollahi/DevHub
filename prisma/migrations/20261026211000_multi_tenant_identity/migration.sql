-- Additive migration: existing single-owner repositories remain associated with their owner.
ALTER TABLE "User" ADD COLUMN "passwordHash" TEXT, ADD COLUMN "disabledAt" TIMESTAMP(3);
ALTER TABLE "Repository" ADD COLUMN "organizationId" UUID, ADD COLUMN "maxStoredBytes" BIGINT NOT NULL DEFAULT 1073741824, ADD COLUMN "storedBytes" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "AgentCredential" ADD COLUMN "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
UPDATE "AgentCredential" AS c SET "scopes" = a."scopes" FROM "AgentIdentity" AS a WHERE c."agentId" = a.id;

CREATE TYPE "MembershipRole" AS ENUM ('OWNER','ADMIN','MEMBER');
CREATE TYPE "GrantEffect" AS ENUM ('ALLOW','DENY');
CREATE TYPE "GrantSubject" AS ENUM ('USER','TEAM','AGENT');
CREATE TABLE "Organization" (
  "id" UUID NOT NULL, "slug" TEXT NOT NULL, "name" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "maxRepositories" INTEGER NOT NULL DEFAULT 100,
  "maxRequestsPerMinute" INTEGER NOT NULL DEFAULT 600,
  CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");
CREATE TABLE "OrganizationMembership" (
  "organizationId" UUID NOT NULL, "userId" UUID NOT NULL, "role" "MembershipRole" NOT NULL DEFAULT 'MEMBER',
  "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrganizationMembership_pkey" PRIMARY KEY ("organizationId","userId")
);
CREATE INDEX "OrganizationMembership_userId_idx" ON "OrganizationMembership"("userId");
CREATE TABLE "Team" ("id" UUID NOT NULL, "organizationId" UUID NOT NULL, "slug" TEXT NOT NULL, "name" TEXT NOT NULL, CONSTRAINT "Team_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "Team_organizationId_slug_key" ON "Team"("organizationId","slug");
CREATE TABLE "TeamMembership" ("teamId" UUID NOT NULL, "userId" UUID NOT NULL, CONSTRAINT "TeamMembership_pkey" PRIMARY KEY ("teamId","userId"));
CREATE TABLE "HumanSession" (
  "id" UUID NOT NULL, "userId" UUID NOT NULL, "tokenHash" CHAR(64) NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL, "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "HumanSession_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "HumanSession_tokenHash_key" ON "HumanSession"("tokenHash");
CREATE INDEX "HumanSession_userId_revokedAt_idx" ON "HumanSession"("userId","revokedAt");
CREATE TABLE "RepositoryGrant" (
  "id" UUID NOT NULL, "repositoryId" UUID NOT NULL, "subjectType" "GrantSubject" NOT NULL,
  "subjectId" UUID NOT NULL, "capability" TEXT NOT NULL, "effect" "GrantEffect" NOT NULL DEFAULT 'ALLOW',
  "pathPrefix" TEXT, "branch" TEXT, "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RepositoryGrant_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "RepositoryGrant_repositoryId_subjectType_subjectId_capability_idx" ON "RepositoryGrant"("repositoryId","subjectType","subjectId","capability");
CREATE TABLE "AgentDelegation" (
  "id" UUID NOT NULL, "agentId" UUID NOT NULL, "repositoryId" UUID NOT NULL, "delegatedBy" UUID NOT NULL,
  "scopes" TEXT[] NOT NULL, "pathPrefix" TEXT, "branch" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL, "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgentDelegation_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AgentDelegation_agentId_repositoryId_revokedAt_idx" ON "AgentDelegation"("agentId","repositoryId","revokedAt");
CREATE TABLE "ApiRateBucket" (
  "repositoryId" UUID NOT NULL, "actorKey" TEXT NOT NULL, "windowStart" TIMESTAMP(3) NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "ApiRateBucket_pkey" PRIMARY KEY ("repositoryId","actorKey","windowStart")
);
ALTER TABLE "Repository" ADD CONSTRAINT "Repository_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OrganizationMembership" ADD CONSTRAINT "OrganizationMembership_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrganizationMembership" ADD CONSTRAINT "OrganizationMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Team" ADD CONSTRAINT "Team_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TeamMembership" ADD CONSTRAINT "TeamMembership_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TeamMembership" ADD CONSTRAINT "TeamMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HumanSession" ADD CONSTRAINT "HumanSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RepositoryGrant" ADD CONSTRAINT "RepositoryGrant_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentDelegation" ADD CONSTRAINT "AgentDelegation_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AgentIdentity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentDelegation" ADD CONSTRAINT "AgentDelegation_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ApiRateBucket" ADD CONSTRAINT "ApiRateBucket_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

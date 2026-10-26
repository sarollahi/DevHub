-- Initial durable contribution data model.
CREATE TYPE "AgentStatus" AS ENUM ('ACTIVE','SUSPENDED','REVOKED');
CREATE TYPE "PullRequestState" AS ENUM ('QUEUED','RUNNING','BLOCKED','FAILED','REVIEW_REQUIRED','APPROVED','MERGING','MERGED','CLOSED');
CREATE TYPE "JobState" AS ENUM ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED');
CREATE TYPE "OutboxState" AS ENUM ('PENDING','PUBLISHED');
CREATE TYPE "CheckState" AS ENUM ('PENDING','RUNNING','SUCCESS','FAILURE','CANCELLED');
CREATE TYPE "ReviewState" AS ENUM ('QUEUED','RUNNING','COMPLETED','FAILED');
CREATE TYPE "RiskTier" AS ENUM ('LOW','MEDIUM','HIGH','CRITICAL');
CREATE TYPE "MergeState" AS ENUM ('PENDING','VALIDATING','READY','MERGING','MERGED','BLOCKED','FAILED');
CREATE TYPE "ApprovalDecision" AS ENUM ('APPROVED','CHANGES_REQUESTED');

CREATE TABLE "User" (
  "id" UUID PRIMARY KEY,
  "handle" TEXT NOT NULL UNIQUE,
  "email" TEXT NOT NULL UNIQUE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "Repository" (
  "id" UUID PRIMARY KEY,
  "ownerId" UUID NOT NULL REFERENCES "User"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "slug" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "defaultBranch" TEXT NOT NULL DEFAULT 'main',
  "maxActivePullRequests" INTEGER NOT NULL DEFAULT 2000,
  "requireHumanApproval" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Repository_ownerId_slug_key" UNIQUE ("ownerId","slug")
);
CREATE INDEX "Repository_slug_idx" ON "Repository"("slug");
CREATE TABLE "AgentIdentity" (
  "id" UUID PRIMARY KEY,
  "ownerId" UUID NOT NULL REFERENCES "User"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "name" TEXT NOT NULL,
  "status" "AgentStatus" NOT NULL DEFAULT 'ACTIVE',
  "scopes" TEXT[] NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgentIdentity_ownerId_name_key" UNIQUE ("ownerId","name")
);
CREATE TABLE "AgentCredential" (
  "id" UUID PRIMARY KEY,
  "agentId" UUID NOT NULL REFERENCES "AgentIdentity"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  "tokenHash" CHAR(64) NOT NULL UNIQUE,
  "label" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "AgentCredential_agentId_revokedAt_idx" ON "AgentCredential"("agentId","revokedAt");
CREATE TABLE "PullRequest" (
  "id" UUID PRIMARY KEY,
  "repositoryId" UUID NOT NULL REFERENCES "Repository"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "agentId" UUID NOT NULL REFERENCES "AgentIdentity"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "idempotencyKey" TEXT NOT NULL,
  "requestHash" CHAR(64) NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "sourceBranch" TEXT NOT NULL,
  "sourceSha" VARCHAR(40) NOT NULL,
  "targetBranch" TEXT NOT NULL,
  "targetSha" VARCHAR(40) NOT NULL,
  "patch" TEXT NOT NULL,
  "changedFiles" TEXT[] NOT NULL,
  "state" "PullRequestState" NOT NULL DEFAULT 'QUEUED',
  "riskTier" "RiskTier",
  "riskScore" INTEGER,
  "version" INTEGER NOT NULL DEFAULT 1,
  "approvedAt" TIMESTAMP(3),
  "mergedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PullRequest_agentId_idempotencyKey_key" UNIQUE ("agentId","idempotencyKey")
);
CREATE INDEX "PullRequest_repositoryId_state_createdAt_idx" ON "PullRequest"("repositoryId","state","createdAt" DESC);
CREATE INDEX "PullRequest_repositoryId_targetBranch_riskScore_createdAt_idx" ON "PullRequest"("repositoryId","targetBranch","riskScore","createdAt");
CREATE INDEX "PullRequest_state_updatedAt_idx" ON "PullRequest"("state","updatedAt");
CREATE TABLE "CheckRun" (
  "id" UUID PRIMARY KEY,
  "pullId" UUID NOT NULL REFERENCES "PullRequest"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "state" "CheckState" NOT NULL DEFAULT 'PENDING',
  "summary" TEXT,
  "logUri" TEXT,
  "startedAt" TIMESTAMP(3),
  "endedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "CheckRun_pullId_name_createdAt_idx" ON "CheckRun"("pullId","name","createdAt");
CREATE TABLE "ReviewRun" (
  "id" UUID PRIMARY KEY,
  "pullId" UUID NOT NULL REFERENCES "PullRequest"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  "model" TEXT NOT NULL,
  "state" "ReviewState" NOT NULL DEFAULT 'QUEUED',
  "findings" JSONB,
  "costMicros" BIGINT NOT NULL DEFAULT 0,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3)
);
CREATE INDEX "ReviewRun_pullId_state_idx" ON "ReviewRun"("pullId","state");
CREATE TABLE "QueueJob" (
  "id" UUID PRIMARY KEY,
  "pullId" UUID NOT NULL REFERENCES "PullRequest"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  "kind" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL UNIQUE,
  "state" "JobState" NOT NULL DEFAULT 'QUEUED',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 5,
  "lastError" TEXT,
  "scheduledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "leaseUntil" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "QueueJob_state_scheduledAt_idx" ON "QueueJob"("state","scheduledAt");
CREATE TABLE "ChangeFingerprint" (
  "id" UUID PRIMARY KEY,
  "repositoryId" UUID NOT NULL REFERENCES "Repository"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "pullId" UUID NOT NULL REFERENCES "PullRequest"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  "sha256" CHAR(64) NOT NULL,
  "fileSetHash" CHAR(64) NOT NULL,
  "relatedCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChangeFingerprint_pullId_key" UNIQUE ("pullId")
);
CREATE INDEX "ChangeFingerprint_repositoryId_sha256_idx" ON "ChangeFingerprint"("repositoryId","sha256");
CREATE INDEX "ChangeFingerprint_repositoryId_fileSetHash_idx" ON "ChangeFingerprint"("repositoryId","fileSetHash");
CREATE TABLE "MergeGroup" (
  "id" UUID PRIMARY KEY,
  "repositoryId" UUID NOT NULL REFERENCES "Repository"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "targetBranch" TEXT NOT NULL,
  "state" "MergeState" NOT NULL DEFAULT 'PENDING',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "MergeGroup_repositoryId_targetBranch_state_idx" ON "MergeGroup"("repositoryId","targetBranch","state");
CREATE TABLE "MergeGroupItem" (
  "mergeGroupId" UUID NOT NULL REFERENCES "MergeGroup"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  "pullId" UUID NOT NULL REFERENCES "PullRequest"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "position" INTEGER NOT NULL,
  PRIMARY KEY ("mergeGroupId","pullId"),
  CONSTRAINT "MergeGroupItem_mergeGroupId_position_key" UNIQUE ("mergeGroupId","position")
);
CREATE TABLE "Approval" (
  "id" UUID PRIMARY KEY,
  "pullId" UUID NOT NULL REFERENCES "PullRequest"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  "userId" UUID NOT NULL REFERENCES "User"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "version" INTEGER NOT NULL,
  "decision" "ApprovalDecision" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Approval_pullId_userId_version_key" UNIQUE ("pullId","userId","version")
);
CREATE TABLE "IngressBucket" (
  "repositoryId" UUID NOT NULL REFERENCES "Repository"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "agentId" UUID NOT NULL REFERENCES "AgentIdentity"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "minute" TIMESTAMP(3) NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY ("repositoryId","agentId","minute")
);
CREATE TABLE "OutboxEvent" (
  "id" UUID PRIMARY KEY,
  "aggregateType" TEXT NOT NULL,
  "aggregateId" UUID NOT NULL,
  "kind" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "state" "OutboxState" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedUntil" TIMESTAMP(3),
  "publishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "OutboxEvent_state_nextAttemptAt_createdAt_idx" ON "OutboxEvent"("state","nextAttemptAt","createdAt");
CREATE INDEX "OutboxEvent_aggregateType_aggregateId_idx" ON "OutboxEvent"("aggregateType","aggregateId");
CREATE TABLE "AuditEvent" (
  "id" UUID PRIMARY KEY,
  "repositoryId" UUID,
  "actorType" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "subjectId" TEXT,
  "metadata" JSONB,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "AuditEvent_repositoryId_occurredAt_idx" ON "AuditEvent"("repositoryId","occurredAt" DESC);
CREATE INDEX "AuditEvent_actorType_actorId_occurredAt_idx" ON "AuditEvent"("actorType","actorId","occurredAt" DESC);

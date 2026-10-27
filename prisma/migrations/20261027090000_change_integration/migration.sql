CREATE TABLE "ChangeIntegration" (
"id" UUID PRIMARY KEY, "repositoryId" UUID NOT NULL REFERENCES "Repository"("id") ON DELETE RESTRICT,
"sourceChangesetId" CHAR(64) NOT NULL REFERENCES "SourceChangeset"("id") ON DELETE RESTRICT,
"targetRef" TEXT NOT NULL, "requestKey" VARCHAR(128) NOT NULL, "mode" TEXT NOT NULL DEFAULT 'MERGE',
"revertIntegrationId" UUID, "state" TEXT NOT NULL DEFAULT 'QUEUED',
"actorType" TEXT NOT NULL, "actorId" TEXT NOT NULL, "actorSessionId" UUID, "actorCredentialId" UUID,
"targetChangesetId" CHAR(64), "baseChangesetId" CHAR(64), "resultChangesetId" CHAR(64),
"targetGeneration" INTEGER, "attempts" INTEGER NOT NULL DEFAULT 0, "maxAttempts" INTEGER NOT NULL DEFAULT 8,
"leaseToken" UUID, "leaseUntil" TIMESTAMP(3), "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
"affectedPaths" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[], "conflicts" JSONB, "lastError" TEXT,
"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
"updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "completedAt" TIMESTAMP(3),
CONSTRAINT "ChangeIntegration_mode_check" CHECK ("mode" IN ('MERGE', 'REVERT')),
CONSTRAINT "ChangeIntegration_attempts_check" CHECK ("maxAttempts" BETWEEN 1 AND 32)
);
CREATE UNIQUE INDEX "ChangeIntegration_repositoryId_requestKey_key" ON "ChangeIntegration"("repositoryId","requestKey");
CREATE INDEX "ChangeIntegration_state_nextAttemptAt_leaseUntil_idx" ON "ChangeIntegration"("state","nextAttemptAt","leaseUntil");
CREATE INDEX "ChangeIntegration_repositoryId_targetRef_createdAt_idx" ON "ChangeIntegration"("repositoryId","targetRef","createdAt" DESC);
CREATE TABLE "IntegrationPolicy" (
"repositoryId" UUID NOT NULL REFERENCES "Repository"("id") ON DELETE CASCADE,
"targetRef" TEXT NOT NULL,
"preChecks" BOOLEAN NOT NULL DEFAULT true, "targetChecks" BOOLEAN NOT NULL DEFAULT true,
"postChecks" BOOLEAN NOT NULL DEFAULT true, "deploymentChecks" BOOLEAN NOT NULL DEFAULT true,
"maxRetries" INTEGER NOT NULL DEFAULT 8, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
CONSTRAINT "IntegrationPolicy_pkey" PRIMARY KEY ("repositoryId","targetRef"),
CONSTRAINT "IntegrationPolicy_maxRetries_check" CHECK ("maxRetries" BETWEEN 1 AND 32)
);

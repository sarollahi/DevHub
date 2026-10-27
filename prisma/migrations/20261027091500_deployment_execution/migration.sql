CREATE TABLE "DeploymentExecution" (
  "id" UUID PRIMARY KEY,
  "repositoryId" UUID NOT NULL REFERENCES "Repository"("id") ON DELETE RESTRICT,
  "integrationId" UUID NOT NULL,
  "revisionId" CHAR(64) NOT NULL,
  "environment" VARCHAR(80) NOT NULL,
  "requestKey" VARCHAR(128) NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'QUEUED',
  "actorId" UUID NOT NULL,
  "actorSessionId" UUID NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 5,
  "leaseToken" UUID,
  "leaseUntil" TIMESTAMP(3),
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "dispatchedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "receipt" JSONB,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DeploymentExecution_attempts_check" CHECK ("maxAttempts" BETWEEN 1 AND 10)
);
CREATE UNIQUE INDEX "DeploymentExecution_repositoryId_environment_requestKey_key"
 ON "DeploymentExecution"("repositoryId","environment","requestKey");
CREATE INDEX "DeploymentExecution_state_nextAttemptAt_leaseUntil_idx"
 ON "DeploymentExecution"("state","nextAttemptAt","leaseUntil");

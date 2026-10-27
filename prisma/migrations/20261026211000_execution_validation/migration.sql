
CREATE TYPE "ValidationExecutionState" AS ENUM ('QUEUED','RUNNING','PASSED','FAILED','ERRORED','TIMED_OUT','CANCELLED');
CREATE TYPE "ValidationKind" AS ENUM ('COMPILE','TEST','LINT','SECURITY','SECRETS','DEPENDENCIES');
CREATE TABLE "ValidationPipeline" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "repositoryId" UUID NOT NULL,
  "changesetId" CHAR(64) NOT NULL,
  "targetChangesetId" CHAR(64),
  "idempotencyKey" TEXT NOT NULL,
  "requestedBy" TEXT NOT NULL,
  "snapshotDigest" CHAR(64) NOT NULL,
  "dependencyDigest" CHAR(64) NOT NULL,
  "configurationDigest" CHAR(64) NOT NULL,
  "state" "ValidationExecutionState" NOT NULL DEFAULT 'QUEUED',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  CONSTRAINT "ValidationPipeline_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ValidationPipeline_repositoryId_idempotencyKey_key" ON "ValidationPipeline"("repositoryId","idempotencyKey");
CREATE INDEX "ValidationPipeline_repositoryId_changesetId_createdAt_idx" ON "ValidationPipeline"("repositoryId","changesetId","createdAt" DESC);
ALTER TABLE "ValidationPipeline" ADD CONSTRAINT "ValidationPipeline_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ValidationPipeline" ADD CONSTRAINT "ValidationPipeline_changesetId_fkey" FOREIGN KEY ("changesetId") REFERENCES "SourceChangeset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ValidationPipeline" ADD CONSTRAINT "ValidationPipeline_targetChangesetId_fkey" FOREIGN KEY ("targetChangesetId") REFERENCES "SourceChangeset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE TABLE "ValidationTask" (
 "id" UUID NOT NULL DEFAULT gen_random_uuid(),
 "pipelineId" UUID NOT NULL,
 "kind" "ValidationKind" NOT NULL,
 "state" "ValidationExecutionState" NOT NULL DEFAULT 'QUEUED',
 "fingerprint" CHAR(64) NOT NULL,
 "image" TEXT NOT NULL,
 "command" TEXT NOT NULL,
 "timeoutSeconds" INTEGER NOT NULL,
 "attempt" INTEGER NOT NULL DEFAULT 0,
 "maxAttempts" INTEGER NOT NULL DEFAULT 3,
 "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "leaseToken" UUID, "leaseUntil" TIMESTAMP(3),
 "runnerId" TEXT, "exitCode" INTEGER, "summary" TEXT,
 "logDigest" CHAR(64), "artifactDigest" CHAR(64),
 "signature" TEXT, "reusedFromId" UUID,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "startedAt" TIMESTAMP(3), "finishedAt" TIMESTAMP(3),
 CONSTRAINT "ValidationTask_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ValidationTask_pipelineId_kind_key" ON "ValidationTask"("pipelineId","kind");
CREATE INDEX "ValidationTask_state_nextAttemptAt_leaseUntil_idx" ON "ValidationTask"("state","nextAttemptAt","leaseUntil");
CREATE INDEX "ValidationTask_fingerprint_state_idx" ON "ValidationTask"("fingerprint","state");
ALTER TABLE "ValidationTask" ADD CONSTRAINT "ValidationTask_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "ValidationPipeline"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE TABLE "ValidationLogChunk" (
 "taskId" UUID NOT NULL, "attempt" INTEGER NOT NULL, "sequence" INTEGER NOT NULL,
 "content" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "ValidationLogChunk_pkey" PRIMARY KEY ("taskId","attempt","sequence")
);
ALTER TABLE "ValidationLogChunk" ADD CONSTRAINT "ValidationLogChunk_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ValidationTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE TABLE "ValidationArtifact" (
 "id" UUID NOT NULL DEFAULT gen_random_uuid(), "taskId" UUID NOT NULL,
 "attempt" INTEGER NOT NULL, "name" TEXT NOT NULL, "mediaType" TEXT NOT NULL,
 "digest" CHAR(64) NOT NULL, "content" BYTEA NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "ValidationArtifact_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ValidationArtifact_taskId_attempt_name_key" ON "ValidationArtifact"("taskId","attempt","name");
ALTER TABLE "ValidationArtifact" ADD CONSTRAINT "ValidationArtifact_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ValidationTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

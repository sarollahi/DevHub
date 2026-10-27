-- Existing immutable changesets are enqueued for authoritative analysis.
CREATE TABLE "SourceReview" (
  "changesetId" CHAR(64) NOT NULL,
  "repositoryId" UUID NOT NULL,
  "state" "ReviewState" NOT NULL DEFAULT 'QUEUED',
  "fingerprint" CHAR(64),
  "paths" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "regions" JSONB,
  "findings" JSONB,
  "related" JSONB,
  "summary" TEXT,
  "groupKey" VARCHAR(64),
  "exactDuplicateOf" CHAR(64),
  "riskTier" "RiskTier",
  "riskScore" INTEGER,
  "provider" TEXT,
  "model" TEXT,
  "confidence" DOUBLE PRECISION,
  "costMicros" BIGINT NOT NULL DEFAULT 0,
  "latencyMs" INTEGER,
  "embedding" JSONB,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "leaseUntil" TIMESTAMP(3),
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "error" TEXT,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SourceReview_pkey" PRIMARY KEY ("changesetId")
);
ALTER TABLE "SourceReview" ADD CONSTRAINT "SourceReview_changesetId_fkey"
  FOREIGN KEY ("changesetId") REFERENCES "SourceChangeset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "SourceReview_state_nextAttemptAt_leaseUntil_idx" ON "SourceReview"("state", "nextAttemptAt", "leaseUntil");
CREATE INDEX "SourceReview_repositoryId_state_createdAt_idx" ON "SourceReview"("repositoryId", "state", "createdAt" DESC);
CREATE INDEX "SourceReview_repositoryId_fingerprint_idx" ON "SourceReview"("repositoryId", "fingerprint");
CREATE INDEX "SourceReview_repositoryId_groupKey_idx" ON "SourceReview"("repositoryId", "groupKey");
INSERT INTO "SourceReview" ("changesetId", "repositoryId")
SELECT "id", "repositoryId" FROM "SourceChangeset"
ON CONFLICT ("changesetId") DO NOTHING;

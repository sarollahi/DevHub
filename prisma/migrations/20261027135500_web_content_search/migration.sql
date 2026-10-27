CREATE TABLE "SourceSearchDocument" (
  "objectId" CHAR(64) NOT NULL PRIMARY KEY,
  "state" "JobState" NOT NULL DEFAULT 'QUEUED',
  "textBody" TEXT,
  "excludedReason" VARCHAR(32),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseUntil" TIMESTAMP(3),
  "lastError" TEXT,
  "indexedAt" TIMESTAMP(3),
  CONSTRAINT "SourceSearchDocument_objectId_fkey" FOREIGN KEY ("objectId") REFERENCES "SourceObject"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "SourceSearchDocument_state_nextAttemptAt_leaseUntil_idx"
  ON "SourceSearchDocument"("state", "nextAttemptAt", "leaseUntil");
-- trigram GIN accelerates substring content queries without exposing raw blobs.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "SourceSearchDocument_textBody_trgm_idx"
  ON "SourceSearchDocument" USING GIN ("textBody" gin_trgm_ops);

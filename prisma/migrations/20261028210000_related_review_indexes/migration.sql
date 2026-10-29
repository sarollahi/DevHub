-- Incremental repository-wide related-change inverted index (v1).
ALTER TABLE "SourceReview" ADD COLUMN "equivalenceHash" CHAR(64),
  ADD COLUMN "candidateCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "relatedTruncated" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "targetRevisionId" CHAR(64),
  ADD COLUMN "indexedAt" TIMESTAMP(3);
ALTER TABLE "SourceReviewRequest" ADD COLUMN "lastTargetRevisionId" CHAR(64),
  ADD COLUMN "lastTargetCheckedAt" TIMESTAMP(3);
CREATE TABLE "SourceReviewSignal" (
  "repositoryId" UUID NOT NULL, "changesetId" CHAR(64) NOT NULL,
  "kind" VARCHAR(20) NOT NULL, "key" VARCHAR(128) NOT NULL,
  CONSTRAINT "SourceReviewSignal_pkey" PRIMARY KEY ("changesetId","kind","key"),
  CONSTRAINT "SourceReviewSignal_review_fkey" FOREIGN KEY ("changesetId")
    REFERENCES "SourceReview"("changesetId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "SourceReviewSignal_repositoryId_kind_key_changesetId_idx"
  ON "SourceReviewSignal"("repositoryId","kind","key","changesetId");
CREATE TABLE "SourceReviewRegion" (
  "id" BIGSERIAL NOT NULL PRIMARY KEY, "repositoryId" UUID NOT NULL,
  "changesetId" CHAR(64) NOT NULL, "path" TEXT NOT NULL,
  "startLine" BIGINT NOT NULL, "endLine" BIGINT NOT NULL,
  "baseObject" CHAR(64),
  CONSTRAINT "SourceReviewRegion_review_fkey" FOREIGN KEY ("changesetId")
    REFERENCES "SourceReview"("changesetId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "SourceReviewRegion_repositoryId_path_startLine_endLine_idx"
  ON "SourceReviewRegion"("repositoryId","path","startLine","endLine");
CREATE INDEX "SourceReviewRegion_changesetId_idx" ON "SourceReviewRegion"("changesetId");
CREATE TABLE "SourceReviewModelCall" (
  "id" UUID NOT NULL PRIMARY KEY, "changesetId" CHAR(64) NOT NULL,
  "operation" TEXT NOT NULL, "provider" TEXT NOT NULL, "model" TEXT NOT NULL,
  "tokens" INTEGER, "costMicros" BIGINT NOT NULL DEFAULT 0,
  "latencyMs" INTEGER NOT NULL, "succeeded" BOOLEAN NOT NULL,
  "error" TEXT, "confidence" DOUBLE PRECISION,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SourceReviewModelCall_review_fkey" FOREIGN KEY ("changesetId")
    REFERENCES "SourceReview"("changesetId") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "SourceReviewModelCall_changesetId_createdAt_idx" ON "SourceReviewModelCall"("changesetId","createdAt");

-- Queue an explicit indexed backfill. This does not remove or approve changes.
UPDATE "SourceReview" SET "state"='QUEUED', "attempts"=0,
  "nextAttemptAt"=CURRENT_TIMESTAMP, "leaseUntil"=NULL,
  "indexedAt"=NULL
WHERE "state" IN ('COMPLETED','FAILED');

-- Reconciliation scans OPEN requests in stable UUID cursor order.
CREATE INDEX "SourceReviewRequest_status_id_idx" ON "SourceReviewRequest"("status", "id");

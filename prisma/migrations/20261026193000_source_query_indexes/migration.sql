-- Derived query tables are mutable caches. Canonical changesets stay immutable.
CREATE TABLE "SourceQueryIndexJob" (
  "changesetId" CHAR(64) NOT NULL,
  "repositoryId" UUID NOT NULL,
  "state" "JobState" NOT NULL DEFAULT 'QUEUED',
  "generation" INTEGER,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseUntil" TIMESTAMP(3),
  "lastError" TEXT,
  "indexedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SourceQueryIndexJob_pkey" PRIMARY KEY ("changesetId")
);
CREATE INDEX "SourceQueryIndexJob_state_nextAttemptAt_leaseUntil_idx"
  ON "SourceQueryIndexJob"("state", "nextAttemptAt", "leaseUntil");
CREATE INDEX "SourceQueryIndexJob_repositoryId_generation_idx"
  ON "SourceQueryIndexJob"("repositoryId", "generation");
ALTER TABLE "SourceQueryIndexJob"
  ADD CONSTRAINT "SourceQueryIndexJob_changesetId_fkey" FOREIGN KEY ("changesetId")
  REFERENCES "SourceChangeset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SourceQueryIndexJob"
  ADD CONSTRAINT "SourceQueryIndexJob_repositoryId_fkey" FOREIGN KEY ("repositoryId")
  REFERENCES "Repository"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "SourceQueryPathTouch" (
  "changesetId" CHAR(64) NOT NULL,
  "path" TEXT NOT NULL,
  "operationPath" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  CONSTRAINT "SourceQueryPathTouch_pkey"
    PRIMARY KEY ("changesetId", "path", "operationPath", "role")
);
CREATE INDEX "SourceQueryPathTouch_path_changesetId_idx"
  ON "SourceQueryPathTouch"("path", "changesetId");
ALTER TABLE "SourceQueryPathTouch"
  ADD CONSTRAINT "SourceQueryPathTouch_changesetId_fkey" FOREIGN KEY ("changesetId")
  REFERENCES "SourceChangeset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Recursive ancestry walks benefit from both directions of the DAG.
CREATE INDEX IF NOT EXISTS "SourceChangesetParent_parentId_idx"
  ON "SourceChangesetParent"("parentId");
CREATE INDEX IF NOT EXISTS "SourceFileOperation_path_idx"
  ON "SourceFileOperation"("path");
CREATE INDEX IF NOT EXISTS "SourceFileOperation_previousPath_idx"
  ON "SourceFileOperation"("previousPath") WHERE "previousPath" IS NOT NULL;

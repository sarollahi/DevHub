-- Persistent Git history mappings and resumable import jobs.
CREATE TYPE "GitImportStatus" AS ENUM ('QUEUED','RUNNING','VERIFY_QUEUED','VERIFYING','FAILED','COMPLETED');
CREATE TABLE "GitImportJob" (
  "id" UUID NOT NULL, "repositoryId" UUID NOT NULL, "sourcePath" TEXT NOT NULL,
  "status" "GitImportStatus" NOT NULL DEFAULT 'QUEUED',
  "workerId" UUID, "leaseUntil" TIMESTAMP(3), "imported" INTEGER NOT NULL DEFAULT 0,
  "lastGitSha" VARCHAR(64), "lastError" TEXT, "verifiedAt" TIMESTAMP(3),
  "startedAt" TIMESTAMP(3), "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GitImportJob_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "GitImportJob_repositoryId_sourcePath_key" ON "GitImportJob"("repositoryId","sourcePath");
CREATE INDEX "GitImportJob_status_leaseUntil_idx" ON "GitImportJob"("status","leaseUntil");
ALTER TABLE "GitImportJob" ADD CONSTRAINT "GitImportJob_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "GitImportCommit" (
  "repositoryId" UUID NOT NULL, "gitSha" VARCHAR(64) NOT NULL,
  "changesetId" CHAR(64) NOT NULL, "gitTreeSha" VARCHAR(64) NOT NULL,
  "authorName" TEXT NOT NULL, "authorEmail" TEXT NOT NULL,
  "authorDate" TIMESTAMP(3) NOT NULL, "authorTimezone" VARCHAR(5) NOT NULL,
  "committerName" TEXT NOT NULL, "committerEmail" TEXT NOT NULL,
  "committerDate" TIMESTAMP(3) NOT NULL, "committerTimezone" VARCHAR(5) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GitImportCommit_pkey" PRIMARY KEY ("repositoryId","gitSha")
);
CREATE UNIQUE INDEX "GitImportCommit_repositoryId_changesetId_key" ON "GitImportCommit"("repositoryId","changesetId");
ALTER TABLE "GitImportCommit" ADD CONSTRAINT "GitImportCommit_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GitImportCommit" ADD CONSTRAINT "GitImportCommit_changesetId_fkey" FOREIGN KEY ("changesetId") REFERENCES "SourceChangeset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "GitImportBlob" (
  "repositoryId" UUID NOT NULL, "gitSha" VARCHAR(64) NOT NULL, "objectId" CHAR(64) NOT NULL,
  CONSTRAINT "GitImportBlob_pkey" PRIMARY KEY ("repositoryId","gitSha")
);
ALTER TABLE "GitImportBlob" ADD CONSTRAINT "GitImportBlob_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GitImportBlob" ADD CONSTRAINT "GitImportBlob_objectId_fkey" FOREIGN KEY ("objectId") REFERENCES "SourceObject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

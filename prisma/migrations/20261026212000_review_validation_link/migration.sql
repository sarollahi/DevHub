ALTER TABLE "PullRequest" ADD COLUMN "nativeChangesetId" CHAR(64);
CREATE INDEX "PullRequest_repositoryId_nativeChangesetId_idx" ON "PullRequest"("repositoryId","nativeChangesetId");

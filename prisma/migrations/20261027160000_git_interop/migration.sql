-- Git is a regenerable projection; only these identity mappings and credentials persist.
CREATE TABLE "GitInteropCommit" (
  "repositoryId" UUID NOT NULL REFERENCES "Repository"("id") ON DELETE CASCADE,
  "changesetId" CHAR(64) NOT NULL REFERENCES "SourceChangeset"("id") ON DELETE RESTRICT,
  "gitSha" CHAR(40) NOT NULL,
  "treeSha" CHAR(40) NOT NULL,
  "rawCommit" BYTEA,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("repositoryId","changesetId"),
  CONSTRAINT "GitInteropCommit_git_unique" UNIQUE ("repositoryId","gitSha")
);
CREATE TABLE "GitInteropBlob" (
  "repositoryId" UUID NOT NULL REFERENCES "Repository"("id") ON DELETE CASCADE,
  "objectId" CHAR(64) NOT NULL REFERENCES "SourceObject"("id") ON DELETE RESTRICT,
  "gitSha" CHAR(40) NOT NULL,
  PRIMARY KEY ("repositoryId","objectId"),
  CONSTRAINT "GitInteropBlob_git_unique" UNIQUE ("repositoryId","gitSha")
);
CREATE TABLE "GitInteropCredential" (
  "id" UUID NOT NULL PRIMARY KEY,
  "repositoryId" UUID NOT NULL REFERENCES "Repository"("id") ON DELETE CASCADE,
  "userId" UUID NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "tokenHash" CHAR(64) NOT NULL UNIQUE,
  "scopes" TEXT[] NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUsedAt" TIMESTAMP(3)
);
CREATE INDEX "GitInteropCredential_repositoryId_userId_idx" ON "GitInteropCredential"("repositoryId","userId");

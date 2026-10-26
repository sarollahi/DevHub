-- External immutable S3 blobs are independently published and protected by FK references.
CREATE TYPE "BlobState" AS ENUM ('PUBLISHING', 'READY', 'DELETING');
CREATE TYPE "BlobTransferState" AS ENUM ('ACTIVE', 'STAGED', 'FINISHED', 'FAILED');
CREATE TABLE "StoredBlob" (
  "id" CHAR(64) PRIMARY KEY,
  "objectKey" TEXT NOT NULL UNIQUE,
  "state" "BlobState" NOT NULL DEFAULT 'PUBLISHING',
  "encoding" VARCHAR(16) NOT NULL,
  "rawSha256" CHAR(64) NOT NULL,
  "rawBytes" BIGINT NOT NULL,
  "storedBytes" BIGINT NOT NULL,
  "stagingKey" TEXT,
  "publisherId" UUID,
  "publishLeaseUntil" TIMESTAMP(3),
  "retainUntil" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "verifiedAt" TIMESTAMP(3),
  CONSTRAINT "StoredBlob_sizes_nonnegative" CHECK ("rawBytes" >= 0 AND "storedBytes" >= 0)
);
CREATE INDEX "StoredBlob_state_publishLeaseUntil_idx" ON "StoredBlob"("state", "publishLeaseUntil");
CREATE INDEX "StoredBlob_state_retainUntil_idx" ON "StoredBlob"("state", "retainUntil");
CREATE TABLE "BlobLease" (
  "repositoryId" UUID NOT NULL REFERENCES "Repository"("id") ON DELETE RESTRICT,
  "objectId" CHAR(64) NOT NULL REFERENCES "StoredBlob"("id") ON DELETE RESTRICT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  PRIMARY KEY ("repositoryId", "objectId")
);
CREATE INDEX "BlobLease_objectId_expiresAt_idx" ON "BlobLease"("objectId", "expiresAt");
CREATE TABLE "BlobTransfer" (
  "id" UUID PRIMARY KEY,
  "repositoryId" UUID NOT NULL REFERENCES "Repository"("id") ON DELETE RESTRICT,
  "stagingKey" TEXT NOT NULL UNIQUE,
  "uploadId" TEXT,
  "state" "BlobTransferState" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE INDEX "BlobTransfer_state_updatedAt_idx" ON "BlobTransfer"("state", "updatedAt");
ALTER TABLE "SourceObject" ALTER COLUMN "data" DROP NOT NULL;
ALTER TABLE "SourceObject" ALTER COLUMN "byteSize" TYPE BIGINT;
ALTER TABLE "SourceObject" ADD COLUMN "externalId" CHAR(64) UNIQUE;
ALTER TABLE "SourceObject" ADD CONSTRAINT "SourceObject_externalId_fkey"
  FOREIGN KEY ("externalId") REFERENCES "StoredBlob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SourceObject" ADD CONSTRAINT "SourceObject_payload_location" CHECK
  (("data" IS NOT NULL AND "externalId" IS NULL)
   OR ("data" IS NULL AND "externalId" = "id" AND "kind" = 'BLOB'));

CREATE TABLE "SourceObjectUpload" (
    "repositoryId" UUID NOT NULL,
    "objectId" CHAR(64) NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "received" INTEGER NOT NULL DEFAULT 0,
    "data" BYTEA NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SourceObjectUpload_pkey" PRIMARY KEY ("repositoryId","objectId"),
    CONSTRAINT "SourceObjectUpload_byteSize_check" CHECK ("byteSize" >= 0 AND "byteSize" <= 4194304),
    CONSTRAINT "SourceObjectUpload_received_check" CHECK ("received" >= 0 AND "received" <= "byteSize")
);
CREATE INDEX "SourceObjectUpload_updatedAt_idx" ON "SourceObjectUpload"("updatedAt");
ALTER TABLE "SourceObjectUpload" ADD CONSTRAINT "SourceObjectUpload_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "SourceReviewRequest" (
    "id" UUID NOT NULL,
    "repositoryId" UUID NOT NULL,
    "changesetId" CHAR(64) NOT NULL,
    "targetRef" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "actorId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SourceReviewRequest_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SourceReviewRequest_repositoryId_changesetId_targetRef_key"
 ON "SourceReviewRequest"("repositoryId","changesetId","targetRef");
CREATE INDEX "SourceReviewRequest_repositoryId_createdAt_idx" ON "SourceReviewRequest"("repositoryId","createdAt" DESC);
ALTER TABLE "SourceReviewRequest" ADD CONSTRAINT "SourceReviewRequest_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SourceReviewRequest" ADD CONSTRAINT "SourceReviewRequest_changesetId_fkey" FOREIGN KEY ("changesetId") REFERENCES "SourceChangeset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

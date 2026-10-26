-- Preserve existing reference generations; deletion is represented by a tombstone.
CREATE TYPE "SourceRefKind" AS ENUM ('BRANCH', 'RELEASE', 'TAG');
ALTER TABLE "SourceReference"
  ADD COLUMN "kind" "SourceRefKind" NOT NULL DEFAULT 'BRANCH',
  ADD COLUMN "deletedAt" TIMESTAMP(3);

UPDATE "SourceReference" SET "kind" = CASE
  WHEN "name" LIKE 'tags/%' THEN 'TAG'::"SourceRefKind"
  WHEN "name" LIKE 'releases/%' THEN 'RELEASE'::"SourceRefKind"
  ELSE 'BRANCH'::"SourceRefKind" END;

CREATE TABLE "SourceReferencePolicy" (
  "repositoryId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "protected" BOOLEAN NOT NULL DEFAULT false,
  "allowForce" BOOLEAN NOT NULL DEFAULT false,
  "allowDelete" BOOLEAN NOT NULL DEFAULT true,
  "requireApproval" BOOLEAN NOT NULL DEFAULT false,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SourceReferencePolicy_pkey" PRIMARY KEY ("repositoryId", "name"),
  CONSTRAINT "SourceReferencePolicy_repositoryId_fkey" FOREIGN KEY ("repositoryId")
    REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "SourceRefMutation" (
  "id" UUID NOT NULL,
  "repositoryId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "mutationId" VARCHAR(128) NOT NULL,
  "requestHash" CHAR(64) NOT NULL,
  "operation" VARCHAR(20) NOT NULL,
  "kind" "SourceRefKind" NOT NULL,
  "oldChangesetId" CHAR(64),
  "newChangesetId" CHAR(64),
  "oldGeneration" INTEGER,
  "newGeneration" INTEGER NOT NULL,
  "actorType" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "forced" BOOLEAN NOT NULL DEFAULT false,
  "reason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SourceRefMutation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SourceRefMutation_repositoryId_fkey" FOREIGN KEY ("repositoryId")
    REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SourceRefMutation_repositoryId_name_mutationId_key"
  ON "SourceRefMutation"("repositoryId", "name", "mutationId");
CREATE UNIQUE INDEX "SourceRefMutation_repositoryId_name_newGeneration_key"
  ON "SourceRefMutation"("repositoryId", "name", "newGeneration");
CREATE INDEX "SourceRefMutation_repositoryId_name_createdAt_idx"
  ON "SourceRefMutation"("repositoryId", "name", "createdAt" DESC);

-- Pre-existing refs were not fully journaled. Preserve an explicit current
-- baseline rather than inventing past operations or actors.
INSERT INTO "SourceRefMutation"
  ("id", "repositoryId", "name", "mutationId", "requestHash", "operation", "kind",
   "oldChangesetId", "newChangesetId", "oldGeneration", "newGeneration",
   "actorType", "actorId", "forced")
SELECT gen_random_uuid(), r."repositoryId", r."name", 'baseline-' || r."generation"::text,
       repeat('0', 64), 'BASELINE', r."kind",
       NULL, r."changesetId", NULL, r."generation",
       'SYSTEM', 'migration', false
FROM "SourceReference" r;

CREATE FUNCTION prevent_ref_journal_edit() RETURNS TRIGGER AS $$
BEGIN
  -- Permit cascading cleanup only when deleting the owning repository.
  -- Direct journal deletions and all edits remain forbidden.
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Reference mutation history is immutable' USING ERRCODE = '23000';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER immutable_ref_journal
BEFORE UPDATE OR DELETE ON "SourceRefMutation"
FOR EACH ROW EXECUTE FUNCTION prevent_ref_journal_edit();

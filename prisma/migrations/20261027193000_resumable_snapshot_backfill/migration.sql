-- Migration progress is operational bookkeeping only. Immutable roots remain
-- the only derived tree anchors; changesets and operations are authoritative.
CREATE TABLE "SourceSnapshotBuild" (
  "targetId" CHAR(64) NOT NULL PRIMARY KEY,
  "repositoryId" UUID NOT NULL,
  "cursorId" CHAR(64),
  "anchorId" CHAR(64),
  "phase" TEXT NOT NULL DEFAULT 'DISCOVER',
  "discovered" INTEGER NOT NULL DEFAULT 0,
  "applied" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SourceSnapshotBuild_targetId_fkey" FOREIGN KEY ("targetId")
    REFERENCES "SourceChangeset"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SourceSnapshotBuild_repositoryId_fkey" FOREIGN KEY ("repositoryId")
    REFERENCES "Repository"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SourceSnapshotBuild_progress_check" CHECK ("discovered" >= "applied" AND "applied" >= 0
    AND "phase" IN ('DISCOVER','APPLY','DONE'))
);
CREATE INDEX "SourceSnapshotBuild_repositoryId_phase_idx" ON "SourceSnapshotBuild"("repositoryId", "phase");

CREATE TABLE "SourceSnapshotBuildStep" (
  "targetId" CHAR(64) NOT NULL,
  "position" INTEGER NOT NULL,
  "changesetId" CHAR(64) NOT NULL,
  CONSTRAINT "SourceSnapshotBuildStep_pkey" PRIMARY KEY ("targetId", "position"),
  CONSTRAINT "SourceSnapshotBuildStep_targetId_fkey" FOREIGN KEY ("targetId")
    REFERENCES "SourceSnapshotBuild"("targetId") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SourceSnapshotBuildStep_changesetId_fkey" FOREIGN KEY ("changesetId")
    REFERENCES "SourceChangeset"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "SourceSnapshotBuildStep_target_changeset_unique" UNIQUE ("targetId", "changesetId")
);
CREATE INDEX "SourceSnapshotBuildStep_changesetId_idx" ON "SourceSnapshotBuildStep"("changesetId");

-- A progress row may only refer to a revision from its own repository.
CREATE OR REPLACE FUNCTION verify_snapshot_build_repository() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "SourceChangeset"
    WHERE id = NEW."targetId" AND "repositoryId" = NEW."repositoryId") THEN
    RAISE EXCEPTION 'snapshot build repository mismatch';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "snapshot_build_repository_guard"
BEFORE INSERT OR UPDATE ON "SourceSnapshotBuild"
FOR EACH ROW EXECUTE FUNCTION verify_snapshot_build_repository();

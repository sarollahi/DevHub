-- Derived immutable Merkle radix snapshots. Existing canonical changesets remain untouched.
-- No default or backfill: historical roots are materialized lazily or by an operator.
CREATE TABLE "SourceSnapshotNode" (
    "id" CHAR(64) NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SourceSnapshotNode_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "SourceSnapshotRoot" (
    "changesetId" CHAR(64) NOT NULL,
    "repositoryId" UUID NOT NULL,
    "rootId" CHAR(64) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SourceSnapshotRoot_pkey" PRIMARY KEY ("changesetId")
);
CREATE INDEX "SourceSnapshotRoot_repositoryId_rootId_idx" ON "SourceSnapshotRoot"("repositoryId", "rootId");
ALTER TABLE "SourceSnapshotRoot" ADD CONSTRAINT "SourceSnapshotRoot_changesetId_fkey"
    FOREIGN KEY ("changesetId") REFERENCES "SourceChangeset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SourceSnapshotRoot" ADD CONSTRAINT "SourceSnapshotRoot_repositoryId_fkey"
    FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SourceSnapshotRoot" ADD CONSTRAINT "SourceSnapshotRoot_rootId_fkey"
    FOREIGN KEY ("rootId") REFERENCES "SourceSnapshotNode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Roots must belong to the corresponding changeset repository. Enforce this
-- even when a privileged maintenance script bypasses the application.
CREATE OR REPLACE FUNCTION verify_snapshot_root_repository() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "SourceChangeset"
                 WHERE id = NEW."changesetId" AND "repositoryId" = NEW."repositoryId") THEN
    RAISE EXCEPTION 'snapshot root repository mismatch';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER "snapshot_root_repository_guard"
BEFORE INSERT OR UPDATE ON "SourceSnapshotRoot"
FOR EACH ROW EXECUTE FUNCTION verify_snapshot_root_repository();

-- V2 native delta changesets. Legacy v1 tree manifests are retained only for
-- older records; new publications store no complete tree per changeset.
ALTER TYPE "SourceOperationKind" ADD VALUE IF NOT EXISTS 'ADD';
ALTER TYPE "SourceOperationKind" ADD VALUE IF NOT EXISTS 'MODIFY';
ALTER TYPE "SourceOperationKind" ADD VALUE IF NOT EXISTS 'RENAME';
ALTER TYPE "SourceOperationKind" ADD VALUE IF NOT EXISTS 'COPY';
ALTER TYPE "SourceOperationKind" ADD VALUE IF NOT EXISTS 'CHMOD';

ALTER TABLE "SourceChangeset" ALTER COLUMN "treeId" DROP NOT NULL;
ALTER TABLE "SourceFileOperation" ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "SourceFileOperation" ADD COLUMN "fileMode" VARCHAR(6);
ALTER TABLE "SourceFileOperation" ADD CONSTRAINT "SourceFileOperation_position_positive" CHECK ("position" >= 0);
ALTER TABLE "SourceFileOperation" ADD CONSTRAINT "SourceFileOperation_fileMode" CHECK ("fileMode" IS NULL OR "fileMode" IN ('100644', '100755', '120000'));

CREATE TABLE "SourceObjectGrant" (
  "repositoryId" UUID NOT NULL REFERENCES "Repository"("id") ON DELETE RESTRICT,
  "objectId" CHAR(64) NOT NULL REFERENCES "SourceObject"("id") ON DELETE RESTRICT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("repositoryId", "objectId")
);
CREATE TABLE "SourcePublicationKey" (
  "repositoryId" UUID NOT NULL REFERENCES "Repository"("id") ON DELETE RESTRICT,
  "authorId" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "changesetId" CHAR(64) NOT NULL REFERENCES "SourceChangeset"("id") ON DELETE RESTRICT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("repositoryId", "authorId", "key")
);
CREATE INDEX "SourcePublicationKey_changesetId_idx" ON "SourcePublicationKey"("changesetId");
CREATE TABLE "SourceChangesetEvent" (
  "id" UUID PRIMARY KEY,
  "repositoryId" UUID NOT NULL REFERENCES "Repository"("id") ON DELETE RESTRICT,
  "changesetId" CHAR(64) NOT NULL UNIQUE REFERENCES "SourceChangeset"("id") ON DELETE RESTRICT,
  "kind" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "SourceChangesetEvent_repositoryId_createdAt_idx" ON "SourceChangesetEvent"("repositoryId", "createdAt");

-- A publication is append-only. Existing v1 test fixture cleanup remains
-- available for v1 records, but v2 records cannot be deleted by any API.
CREATE FUNCTION "reject_canonical_changeset_delete"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."treeId" IS NULL THEN
    RAISE EXCEPTION 'Canonical changesets are append-only';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER "SourceChangeset_no_canonical_delete" BEFORE DELETE ON "SourceChangeset"
  FOR EACH ROW EXECUTE FUNCTION "reject_canonical_changeset_delete"();

CREATE FUNCTION "reject_canonical_operation_delete"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "SourceChangeset" WHERE id = OLD."changesetId" AND "treeId" IS NULL) THEN
    RAISE EXCEPTION 'Canonical changeset operations are append-only';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER "SourceFileOperation_no_canonical_delete" BEFORE DELETE ON "SourceFileOperation"
  FOR EACH ROW EXECUTE FUNCTION "reject_canonical_operation_delete"();
CREATE TRIGGER "SourceChangesetParent_no_canonical_delete" BEFORE DELETE ON "SourceChangesetParent"
  FOR EACH ROW EXECUTE FUNCTION "reject_canonical_operation_delete"();

CREATE TRIGGER "SourcePublicationKey_immutable" BEFORE UPDATE OR DELETE ON "SourcePublicationKey"
  FOR EACH ROW EXECUTE FUNCTION "reject_source_mutation"();
CREATE TRIGGER "SourceChangesetEvent_immutable" BEFORE UPDATE OR DELETE ON "SourceChangesetEvent"
  FOR EACH ROW EXECUTE FUNCTION "reject_source_mutation"();

-- Detail rows must be inserted in the same transaction that creates their
-- immutable header. Otherwise a later INSERT could silently rewrite history
-- without performing an UPDATE against an immutable row.
CREATE FUNCTION "check_source_detail_publication"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  header_repo UUID;
  header_tx TEXT;
BEGIN
  SELECT c."repositoryId", c.xmin::text INTO header_repo, header_tx
  FROM "SourceChangeset" c WHERE c.id = NEW."changesetId";
  IF header_tx IS NULL OR header_tx <> (txid_current() % 4294967296)::text THEN
    RAISE EXCEPTION 'Immutable changeset details may only be inserted in the publication transaction';
  END IF;
  IF TG_TABLE_NAME = 'SourceChangesetParent' AND NOT EXISTS (
    SELECT 1 FROM "SourceChangeset" p WHERE p.id = NEW."parentId" AND p."repositoryId" = header_repo
  ) THEN
    RAISE EXCEPTION 'Parent must be committed in the same repository';
  END IF;
  IF TG_TABLE_NAME = 'SourceChangesetEvent' AND NEW."repositoryId" <> header_repo THEN
    RAISE EXCEPTION 'Publication event repository mismatch';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "SourceFileOperation_publication_only" BEFORE INSERT ON "SourceFileOperation"
  FOR EACH ROW EXECUTE FUNCTION "check_source_detail_publication"();
CREATE TRIGGER "SourceChangesetParent_publication_only" BEFORE INSERT ON "SourceChangesetParent"
  FOR EACH ROW EXECUTE FUNCTION "check_source_detail_publication"();
CREATE TRIGGER "SourceChangesetEvent_publication_only" BEFORE INSERT ON "SourceChangesetEvent"
  FOR EACH ROW EXECUTE FUNCTION "check_source_detail_publication"();
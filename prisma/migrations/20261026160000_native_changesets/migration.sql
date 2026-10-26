-- Native immutable source-control persistence; legacy contribution records remain unchanged.
CREATE TYPE "SourceObjectKind" AS ENUM ('BLOB', 'TREE');
CREATE TYPE "SourceOperationKind" AS ENUM ('PUT', 'DELETE', 'MOVE');

CREATE TABLE "SourceObject" (
  "id" CHAR(64) PRIMARY KEY,
  "kind" "SourceObjectKind" NOT NULL,
  "data" BYTEA NOT NULL,
  "byteSize" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SourceObject_size_nonnegative" CHECK ("byteSize" >= 0)
);

CREATE TABLE "SourceChangeset" (
  "id" CHAR(64) PRIMARY KEY,
  "repositoryId" UUID NOT NULL REFERENCES "Repository"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "treeId" CHAR(64) NOT NULL REFERENCES "SourceObject"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "authorId" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "SourceChangeset_repositoryId_createdAt_idx" ON "SourceChangeset"("repositoryId", "createdAt" DESC);

CREATE TABLE "SourceChangesetParent" (
  "changesetId" CHAR(64) NOT NULL REFERENCES "SourceChangeset"("id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  "parentId" CHAR(64) NOT NULL REFERENCES "SourceChangeset"("id") ON UPDATE NO ACTION ON DELETE NO ACTION,
  "position" INTEGER NOT NULL,
  PRIMARY KEY ("changesetId", "parentId"),
  CONSTRAINT "SourceChangesetParent_changesetId_position_key" UNIQUE ("changesetId", "position"),
  CONSTRAINT "SourceChangesetParent_no_self_parent" CHECK ("changesetId" <> "parentId")
);

CREATE TABLE "SourceFileOperation" (
  "changesetId" CHAR(64) NOT NULL REFERENCES "SourceChangeset"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  "path" TEXT NOT NULL,
  "kind" "SourceOperationKind" NOT NULL,
  "previousPath" TEXT,
  "objectId" CHAR(64) REFERENCES "SourceObject"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  PRIMARY KEY ("changesetId", "path")
);

CREATE TABLE "SourceValidation" (
  "changesetId" CHAR(64) PRIMARY KEY REFERENCES "SourceChangeset"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  "state" "CheckState" NOT NULL,
  "summary" TEXT NOT NULL,
  "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "SourceChangeApproval" (
  "changesetId" CHAR(64) NOT NULL REFERENCES "SourceChangeset"("id") ON UPDATE CASCADE ON DELETE CASCADE,
  "userId" UUID NOT NULL REFERENCES "User"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "decision" "ApprovalDecision" NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("changesetId", "userId")
);

CREATE TABLE "SourceReference" (
  "repositoryId" UUID NOT NULL REFERENCES "Repository"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "name" TEXT NOT NULL,
  "changesetId" CHAR(64) NOT NULL REFERENCES "SourceChangeset"("id") ON UPDATE CASCADE ON DELETE RESTRICT,
  "generation" INTEGER NOT NULL DEFAULT 1,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  PRIMARY KEY ("repositoryId", "name"),
  CONSTRAINT "SourceReference_generation_positive" CHECK ("generation" > 0)
);
CREATE INDEX "SourceReference_changesetId_idx" ON "SourceReference"("changesetId");

-- Updates would violate content-addressed identity. Deletion remains an explicit
-- administrative retention operation and is constrained by foreign keys.
CREATE FUNCTION "reject_source_mutation"() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Immutable source-control records cannot be updated';
END;
$$;
CREATE TRIGGER "SourceObject_immutable" BEFORE UPDATE ON "SourceObject"
  FOR EACH ROW EXECUTE FUNCTION "reject_source_mutation"();
CREATE TRIGGER "SourceChangeset_immutable" BEFORE UPDATE ON "SourceChangeset"
  FOR EACH ROW EXECUTE FUNCTION "reject_source_mutation"();
CREATE TRIGGER "SourceChangesetParent_immutable" BEFORE UPDATE ON "SourceChangesetParent"
  FOR EACH ROW EXECUTE FUNCTION "reject_source_mutation"();
CREATE TRIGGER "SourceFileOperation_immutable" BEFORE UPDATE ON "SourceFileOperation"
  FOR EACH ROW EXECUTE FUNCTION "reject_source_mutation"();

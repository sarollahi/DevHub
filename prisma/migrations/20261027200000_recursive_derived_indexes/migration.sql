-- Derived metadata is advisory; canonical changesets and operations remain authoritative.
CREATE TABLE "SourceDerivedIndex" (
  "repositoryId" UUID NOT NULL,
  "changesetId" CHAR(64) NOT NULL REFERENCES "SourceChangeset"("id") ON DELETE CASCADE,
  "kind" VARCHAR(32) NOT NULL,
  "version" INTEGER NOT NULL,
  "state" VARCHAR(16) NOT NULL DEFAULT 'QUEUED',
  "payload" JSONB,
  "checksum" CHAR(64),
  "leaseToken" UUID,
  "leaseUntil" TIMESTAMPTZ,
  "nextAttemptAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "finishedAt" TIMESTAMPTZ,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("changesetId","kind","version"),
  CONSTRAINT "SourceDerivedIndex_state_check" CHECK ("state" IN ('QUEUED','RUNNING','SUCCEEDED','FAILED')),
  CONSTRAINT "SourceDerivedIndex_published_check" CHECK (
    ("state" = 'SUCCEEDED' AND "payload" IS NOT NULL AND "checksum" IS NOT NULL AND "finishedAt" IS NOT NULL)
    OR "state" <> 'SUCCEEDED'
  )
);
CREATE INDEX "SourceDerivedIndex_queue_idx" ON "SourceDerivedIndex" ("state","nextAttemptAt","leaseUntil");
CREATE INDEX "SourceDerivedIndex_repo_idx" ON "SourceDerivedIndex" ("repositoryId","kind","version","state");

CREATE TABLE "SourceDerivedJump" (
  "repositoryId" UUID NOT NULL,
  "changesetId" CHAR(64) NOT NULL REFERENCES "SourceChangeset"("id") ON DELETE CASCADE,
  "level" INTEGER NOT NULL CHECK ("level" >= 0 AND "level" < 63),
  "ancestorId" CHAR(64) NOT NULL REFERENCES "SourceChangeset"("id") ON DELETE RESTRICT,
  PRIMARY KEY ("changesetId","level")
);
CREATE INDEX "SourceDerivedJump_ancestor_idx" ON "SourceDerivedJump" ("repositoryId","ancestorId");

CREATE TABLE "SourceDerivedPathEvent" (
  "repositoryId" UUID NOT NULL,
  "changesetId" CHAR(64) NOT NULL REFERENCES "SourceChangeset"("id") ON DELETE CASCADE,
  "position" INTEGER NOT NULL,
  "role" VARCHAR(16) NOT NULL CHECK ("role" IN ('destination','source')),
  "path" TEXT NOT NULL,
  "generation" INTEGER NOT NULL,
  "kind" VARCHAR(16) NOT NULL,
  "previousPath" TEXT,
  "objectId" CHAR(64),
  PRIMARY KEY ("changesetId","position","role")
);
CREATE INDEX "SourceDerivedPathEvent_path_idx"
  ON "SourceDerivedPathEvent" ("repositoryId","path","generation" DESC);
CREATE INDEX "SourceDerivedPathEvent_revision_idx" ON "SourceDerivedPathEvent" ("repositoryId","changesetId");

-- Immutable published output. A stale worker cannot replace a completed result
-- or edit the postings/jumps written in the same commit.
CREATE FUNCTION reject_published_derived_update() RETURNS TRIGGER AS $$
BEGIN
  IF OLD."state" = 'SUCCEEDED' THEN
    RAISE EXCEPTION 'immutable published derived index';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "SourceDerivedIndex_immutable"
  BEFORE UPDATE OR DELETE ON "SourceDerivedIndex"
  FOR EACH ROW EXECUTE FUNCTION reject_published_derived_update();
CREATE FUNCTION reject_derived_posting_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'immutable derived posting';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "SourceDerivedJump_immutable"
  BEFORE UPDATE OR DELETE ON "SourceDerivedJump"
  FOR EACH ROW EXECUTE FUNCTION reject_derived_posting_mutation();
CREATE TRIGGER "SourceDerivedPathEvent_immutable"
  BEFORE UPDATE OR DELETE ON "SourceDerivedPathEvent"
  FOR EACH ROW EXECUTE FUNCTION reject_derived_posting_mutation();

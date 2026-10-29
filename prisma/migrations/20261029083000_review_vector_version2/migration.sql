-- v2 ANN signals use unbiased signed projections and additional bands.
-- Previously completed embedding-bearing reviews must rebuild their vector keys.
-- Never modify approval decisions or drop any changeset based on similarity.
UPDATE "SourceReview"
SET "state"='QUEUED', "attempts"=0, "nextAttemptAt"=CURRENT_TIMESTAMP,
    "leaseUntil"=NULL, "indexedAt"=NULL
WHERE "state"='COMPLETED' AND "embedding" IS NOT NULL;

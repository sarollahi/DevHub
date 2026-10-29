CREATE TABLE "TenantLaneTurn" (
  "lane" VARCHAR(24) NOT NULL,
  "tenantId" UUID NOT NULL,
  "lastClaimedAt" TIMESTAMP(3),
  "claimCount" BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT "TenantLaneTurn_pkey" PRIMARY KEY ("lane","tenantId")
);
CREATE INDEX "TenantLaneTurn_lane_lastClaimedAt_idx"
  ON "TenantLaneTurn"("lane","lastClaimedAt");

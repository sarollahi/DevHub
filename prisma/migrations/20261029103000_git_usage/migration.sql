CREATE TABLE "GitTrafficUsage" (
  "repositoryId" UUID NOT NULL,
  "day" DATE NOT NULL,
  "ingressBytes" BIGINT NOT NULL DEFAULT 0,
  "egressBytes" BIGINT NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "GitTrafficUsage_pkey" PRIMARY KEY ("repositoryId","day")
);
CREATE INDEX "GitTrafficUsage_day_idx" ON "GitTrafficUsage"("day");

CREATE TABLE "TenantRateBucket" (
    "tenantId" UUID NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "TenantRateBucket_pkey" PRIMARY KEY ("tenantId","windowStart")
);
CREATE INDEX "TenantRateBucket_windowStart_idx" ON "TenantRateBucket"("windowStart");

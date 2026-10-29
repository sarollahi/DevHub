-- Additive migration, safe for rolling application upgrades.
CREATE TABLE "GitGatewayLease" (
    "repositoryId" UUID NOT NULL PRIMARY KEY,
    "token" UUID NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "GitGatewayLease_expiresAt_idx" ON "GitGatewayLease"("expiresAt");
ALTER TABLE "QueueJob" ADD COLUMN "leaseToken" UUID;

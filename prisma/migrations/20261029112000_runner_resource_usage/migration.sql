ALTER TABLE "ValidationTask" ADD COLUMN "measuredCpuNanos" BIGINT;
ALTER TABLE "ValidationTask" ADD COLUMN "sampledMemoryPeakBytes" BIGINT;
ALTER TABLE "ValidationTask" ADD COLUMN "containerNetworkRxBytes" BIGINT;
ALTER TABLE "ValidationTask" ADD COLUMN "containerNetworkTxBytes" BIGINT;
ALTER TABLE "ValidationTask" ADD COLUMN "resourceMeasurementStatus" VARCHAR(24);

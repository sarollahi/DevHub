import { Prisma } from "@prisma/client";
import { db } from "../lib/prisma";

export type Lane = "integration" | "review" | "validation" | "source-index";
type Candidate = { id: string; tenantId: string };
type Transaction = Prisma.TransactionClient;

// These are fixed, non-interpolated SQL statements; no input can become SQL.
// One eligible job per tenant prevents a tenant with millions of queued jobs
// from occupying the candidate window ahead of a smaller tenant.
const candidateSQL: Record<Lane, string> = {
  integration: `
    WITH candidates AS (
      SELECT i.id, COALESCE(r."organizationId",r."ownerId") AS "tenantId",
        i."nextAttemptAt" AS ready,
        row_number() OVER (PARTITION BY COALESCE(r."organizationId",r."ownerId")
          ORDER BY i."nextAttemptAt", i.id) AS ordinal
      FROM "ChangeIntegration" i JOIN "Repository" r ON r.id=i."repositoryId"
      WHERE (i.state IN ('QUEUED','WAITING_CHECKS','WAITING_APPROVAL','RETRY')
          AND i."nextAttemptAt"<=now())
        OR (i.state='PREPARING' AND i."leaseUntil"<now())
    )
    SELECT c.id,c."tenantId" FROM candidates c
    LEFT JOIN "TenantLaneTurn" t ON t.lane='integration' AND t."tenantId"=c."tenantId"
    WHERE c.ordinal=1
    ORDER BY t."lastClaimedAt" ASC NULLS FIRST,c.ready ASC,c.id ASC LIMIT 64`,
  review: `
    WITH candidates AS (
      SELECT v."changesetId" AS id, COALESCE(r."organizationId",r."ownerId") AS "tenantId",
        v."nextAttemptAt" AS ready,
        row_number() OVER (PARTITION BY COALESCE(r."organizationId",r."ownerId")
          ORDER BY v."nextAttemptAt",v."changesetId") AS ordinal
      FROM "SourceReview" v JOIN "Repository" r ON r.id=v."repositoryId"
      WHERE v.attempts<4 AND ((v.state='QUEUED' AND v."nextAttemptAt"<=now())
        OR (v.state='RUNNING' AND v."leaseUntil"<now()))
    )
    SELECT c.id,c."tenantId" FROM candidates c
    LEFT JOIN "TenantLaneTurn" t ON t.lane='review' AND t."tenantId"=c."tenantId"
    WHERE c.ordinal=1
    ORDER BY t."lastClaimedAt" ASC NULLS FIRST,c.ready ASC,c.id ASC LIMIT 64`,
  validation: `
    WITH candidates AS (
      SELECT v.id, COALESCE(r."organizationId",r."ownerId") AS "tenantId",
        v."nextAttemptAt" AS ready,
        row_number() OVER (PARTITION BY COALESCE(r."organizationId",r."ownerId")
          ORDER BY v."createdAt",v.id) AS ordinal
      FROM "ValidationTask" v JOIN "ValidationPipeline" p ON p.id=v."pipelineId"
      JOIN "Repository" r ON r.id=p."repositoryId"
      WHERE p.state <> 'CANCELLED' AND v.attempt<v."maxAttempts"
      AND ((v.state='QUEUED' AND v."nextAttemptAt"<=now())
        OR (v.state='RUNNING' AND v."leaseUntil"<now()))
    )
    SELECT c.id,c."tenantId" FROM candidates c
    LEFT JOIN "TenantLaneTurn" t ON t.lane='validation' AND t."tenantId"=c."tenantId"
    WHERE c.ordinal=1
    ORDER BY t."lastClaimedAt" ASC NULLS FIRST,c.ready ASC,c.id ASC LIMIT 64`,
  "source-index": `
    WITH candidates AS (
      SELECT j."changesetId" AS id, COALESCE(r."organizationId",r."ownerId") AS "tenantId",
        j."nextAttemptAt" AS ready,
        row_number() OVER (PARTITION BY COALESCE(r."organizationId",r."ownerId")
          ORDER BY j."nextAttemptAt",j."changesetId") AS ordinal
      FROM "SourceQueryIndexJob" j JOIN "Repository" r ON r.id=j."repositoryId"
      WHERE j."nextAttemptAt"<=now()
        AND (j.state='QUEUED' OR (j.state='RUNNING' AND j."leaseUntil"<now()))
    )
    SELECT c.id,c."tenantId" FROM candidates c
    LEFT JOIN "TenantLaneTurn" t ON t.lane='source-index' AND t."tenantId"=c."tenantId"
    WHERE c.ordinal=1
    ORDER BY t."lastClaimedAt" ASC NULLS FIRST,c.ready ASC,c.id ASC LIMIT 64`,
};
const activeSQL: Record<Lane, string> = {
  integration: `SELECT COUNT(*)::int AS active FROM "ChangeIntegration" j
    JOIN "Repository" r ON r.id=j."repositoryId"
    WHERE COALESCE(r."organizationId",r."ownerId")=$1::uuid
      AND j.state='PREPARING' AND j."leaseUntil">now()`,
  review: `SELECT COUNT(*)::int AS active FROM "SourceReview" j
    JOIN "Repository" r ON r.id=j."repositoryId"
    WHERE COALESCE(r."organizationId",r."ownerId")=$1::uuid
      AND j.state='RUNNING' AND j."leaseUntil">now()`,
  validation: `SELECT COUNT(*)::int AS active FROM "ValidationTask" j
    JOIN "ValidationPipeline" p ON p.id=j."pipelineId"
    JOIN "Repository" r ON r.id=p."repositoryId"
    WHERE COALESCE(r."organizationId",r."ownerId")=$1::uuid
      AND j.state='RUNNING' AND j."leaseUntil">now()`,
  "source-index": `SELECT COUNT(*)::int AS active FROM "SourceQueryIndexJob" j
    JOIN "Repository" r ON r.id=j."repositoryId"
    WHERE COALESCE(r."organizationId",r."ownerId")=$1::uuid
      AND j.state='RUNNING' AND j."leaseUntil">now()`,
};
const caps: Record<Lane, [string, number]> = {
  integration: ["INTEGRATION_TENANT_RUNNING", 2],
  review: ["DEVHUB_REVIEW_TENANT_RUNNING", 2],
  validation: ["VALIDATION_TENANT_RUNNING", 2],
  "source-index": ["INDEX_TENANT_RUNNING", 2],
};
export async function fairCandidates(lane: Lane): Promise<Candidate[]> {
  return db.$queryRawUnsafe<Candidate[]>(candidateSQL[lane]);
}

/**
 * The tenant row is a cross-replica mutex for admission and turning.
 * The canonical job's expiring DB lease determines active capacity; therefore
 * SIGKILL cannot permanently consume a slot. Refuse to grant a turn when the
 * candidate's guarded CAS fails.
 */
export async function fairClaim<T>(lane: Lane, tenantId: string,
  claim: (tx: Transaction) => Promise<T | null>): Promise<T | null> {
  const [envKey, defaultCap] = caps[lane];
  const configured = Number(process.env[envKey] ?? defaultCap);
  const maxRunning = Number.isSafeInteger(configured) ? Math.max(1,Math.min(64,configured)) : defaultCap;
  return db.$transaction(async tx => {
    // Prisma's empty-update upsert can use a SELECT/INSERT sequence.
    // Two replicas claiming the same previously unseen tenant can then race
    // on the (lane, tenantId) PK. An atomic INSERT ... ON CONFLICT is safe.
    await tx.$executeRaw`
      INSERT INTO "TenantLaneTurn" (lane, "tenantId")
      VALUES (${lane}, ${tenantId}::uuid)
      ON CONFLICT (lane, "tenantId") DO NOTHING`;
    const locked = await tx.$queryRaw<Array<{ tenantId: string }>>`
      SELECT "tenantId" FROM "TenantLaneTurn" WHERE lane=${lane}
        AND "tenantId"=${tenantId}::uuid FOR UPDATE SKIP LOCKED`;
    if (!locked.length) return null;
    const activeRows = await tx.$queryRawUnsafe<Array<{ active: number }>>(activeSQL[lane], tenantId);
    if (Number(activeRows[0]?.active ?? 0) >= maxRunning) return null;
    const result = await claim(tx);
    if (result === null) return null;
    await tx.tenantLaneTurn.update({ where: { lane_tenantId: { lane, tenantId } },
      data: { lastClaimedAt: new Date(), claimCount: { increment: 1 } } });
    return result;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 15000 });
}

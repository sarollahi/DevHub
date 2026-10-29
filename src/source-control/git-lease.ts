import { randomUUID } from "node:crypto";
import { db } from "../lib/prisma";
import { SourceControlError } from "./contracts";

// A DB-time lease coordinates independent gateways without keeping a database
// transaction open while Git transfers untrusted, potentially large packs.
// A pre-receive hook additionally locks/fences this row within the native CAS.
const TTL_MS = 90_000;
const WAIT_MS = 20_000;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export async function acquireGitLease(repositoryId: string, waitMs = WAIT_MS) {
  const token = randomUUID();
  const deadline = Date.now() + waitMs;
  while (true) {
    const claimed = await db.$queryRaw<Array<{ token: string }>>`
      INSERT INTO "GitGatewayLease" ("repositoryId","token","expiresAt","updatedAt")
      VALUES (${repositoryId}::uuid, ${token}::uuid, now() + interval '90 seconds', now())
      ON CONFLICT ("repositoryId") DO UPDATE SET
        "token"=EXCLUDED."token", "expiresAt"=EXCLUDED."expiresAt", "updatedAt"=now()
      WHERE "GitGatewayLease"."expiresAt" < now()
      RETURNING "token"`;
    if (claimed.length) return token;
    if (Date.now() >= deadline)
      throw new SourceControlError(503, "GIT_GATEWAY_BUSY", "Another Git session is active; retry");
    await sleep(Math.min(300, Math.max(40, deadline - Date.now())));
  }
}

export async function renewGitLease(repositoryId: string, token: string) {
  const count = await db.$executeRaw`
    UPDATE "GitGatewayLease" SET "expiresAt"=now()+interval '90 seconds', "updatedAt"=now()
    WHERE "repositoryId"=${repositoryId}::uuid AND "token"=${token}::uuid
      AND "expiresAt">now()`;
  return count === 1;
}

export async function releaseGitLease(repositoryId: string, token: string) {
  // A released session may never clear a newer owner's lease.
  await db.$executeRaw`
    DELETE FROM "GitGatewayLease" WHERE "repositoryId"=${repositoryId}::uuid
      AND "token"=${token}::uuid`;
}

export async function requireGitLease(repositoryId: string, token: string) {
  const rows = await db.$queryRaw<Array<{ token: string }>>`
    SELECT "token" FROM "GitGatewayLease"
    WHERE "repositoryId"=${repositoryId}::uuid AND "token"=${token}::uuid
      AND "expiresAt">now()`;
  if (!rows.length) throw new SourceControlError(409, "GIT_LEASE_LOST", "Git gateway lease lost; retry push");
}

// Aborts the active RPC if the database becomes unreachable, or if ownership
// is stolen after TTL. Redis is not part of this safety boundary.
export async function withGitLease<T>(
  repositoryId: string, work: (token: string) => Promise<T>, onLost: () => void,
): Promise<T> {
  const token = await acquireGitLease(repositoryId);
  let lost = false;
  let refreshing = false;
  const timer = setInterval(() => {
    if (refreshing || lost) return;
    refreshing = true;
    void renewGitLease(repositoryId, token).then(ok => {
      if (!ok) { lost = true; onLost(); }
    }).catch(() => { lost = true; onLost(); }).finally(() => { refreshing = false; });
  }, 15_000);
  timer.unref();
  try {
    const result = await work(token);
    if (lost || !(await renewGitLease(repositoryId, token)))
      throw new SourceControlError(409, "GIT_LEASE_LOST", "Git session lost ownership");
    return result;
  } finally {
    clearInterval(timer);
    await releaseGitLease(repositoryId, token).catch(() => undefined);
  }
}

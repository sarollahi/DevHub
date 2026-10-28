import { Prisma } from "@prisma/client";
import { db } from "../lib/prisma";

/**
 * Exact non-recursive DAG closure. A transaction-local indexed work table
 * deduplicates each reachable revision. PostgreSQL spills the temporary table
 * to disk as needed; application memory holds at most 512 IDs per batch.
 *
 * Unlike a recursive CTE, this is resumable at the batch boundary inside the
 * transaction and can be reused for impact, full history and merge-base reads.
 * Cold use is necessarily proportional to the reachable DAG; hot reachability
 * and merge-base queries prefer indexed merge-spine shortcuts.
 */
type Tx = Prisma.TransactionClient;
type Table = "devhub_walk_a" | "devhub_walk_b";
const name = (table: Table) => Prisma.raw('"' + table + '"');
export async function stageDag(tx: Tx, repositoryId: string, tip: string, table: Table,
  stopAt?: string): Promise<{ visited: number; found: boolean }> {
  const tableName = name(table);
  await tx.$executeRaw(Prisma.sql`CREATE TEMP TABLE ${tableName} (
    id CHAR(64) PRIMARY KEY, processed BOOLEAN NOT NULL DEFAULT FALSE
  ) ON COMMIT DROP`);
  await tx.$executeRaw(Prisma.sql`INSERT INTO ${tableName} (id) VALUES (${tip})`);
  let visited = 0;
  while (true) {
    const batch = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT id FROM ${tableName} WHERE processed = FALSE ORDER BY id LIMIT 512`);
    if (!batch.length) break;
    visited += batch.length;
    const ids = batch.map(row => row.id);
    if (stopAt && ids.includes(stopAt)) return { visited, found: true };
    await tx.$executeRaw(Prisma.sql`UPDATE ${tableName} SET processed = TRUE
      WHERE id IN (${Prisma.join(ids)})`);
    await tx.$executeRaw(Prisma.sql`INSERT INTO ${tableName} (id)
      SELECT p."parentId" FROM "SourceChangesetParent" p
      JOIN "SourceChangeset" c ON c.id = p."parentId" AND c."repositoryId" = ${repositoryId}::uuid
      WHERE p."changesetId" IN (${Prisma.join(ids)})
      ON CONFLICT (id) DO NOTHING`);
  }
  return { visited, found: false };
}
export async function exactDagReachability(repositoryId: string, ancestor: string, descendant: string) {
  if (ancestor === descendant) return true;
  return db.$transaction(async tx =>
    (await stageDag(tx, repositoryId, descendant, "devhub_walk_a", ancestor)).found,
  { timeout: 300000 });
}
export async function exactDagAncestors(repositoryId: string, revision: string, size: number) {
  return db.$transaction(async tx => {
    await stageDag(tx, repositoryId, revision, "devhub_walk_a");
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "devhub_walk_a" ORDER BY id LIMIT ${size}`;
    const counts = await tx.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*) AS count FROM "devhub_walk_a"`;
    const count = Number(counts[0].count);
    return { revision, ancestorCount: count - 1, ancestors: rows.map(r => r.id),
      truncated: count > size, mergeBases: [] as string[] };
  }, { timeout: 300000 });
}
export async function exactDagMergeBases(repositoryId: string, left: string, right: string) {
  if (left === right) return [left];
  return db.$transaction(async tx => {
    await stageDag(tx, repositoryId, left, "devhub_walk_a");
    await stageDag(tx, repositoryId, right, "devhub_walk_b");
    const rows = await tx.$queryRaw<{ id: string }[]>`
      WITH shared AS (
        SELECT a.id FROM "devhub_walk_a" a INNER JOIN "devhub_walk_b" b ON a.id = b.id
      )
      SELECT s.id FROM shared s WHERE NOT EXISTS (
        SELECT 1 FROM "SourceChangesetParent" p
        INNER JOIN shared child ON child.id = p."changesetId"
        WHERE p."parentId" = s.id
      ) ORDER BY s.id`;
    return rows.map(r => r.id);
  }, { timeout: 300000 });
}
export async function exactDagPathImpact(repositoryId: string, revision: string, path: string, size: number) {
  return db.$transaction(async tx => {
    await stageDag(tx, repositoryId, revision, "devhub_walk_a");
    const rows = await tx.$queryRaw<{
      changesetId: string; operationPath: string; role: string; total: bigint;
    }[]>`
      WITH touched AS (
        SELECT op."changesetId", op.path AS "operationPath",
          CASE WHEN op.path = ${path} THEN 'destination' ELSE 'source' END AS role
        FROM "SourceFileOperation" op
        INNER JOIN "devhub_walk_a" reachable ON reachable.id = op."changesetId"
        WHERE (op.path = ${path} OR op."previousPath" = ${path})
      )
      SELECT t."changesetId", t."operationPath", t.role, COUNT(*) OVER () AS total
      FROM touched t JOIN "SourceChangeset" c ON c.id = t."changesetId"
      WHERE c."repositoryId" = ${repositoryId}::uuid
      ORDER BY c."createdAt" DESC, t."changesetId", t.role LIMIT ${size + 1}`;
    const total = Number(rows[0]?.total ?? 0n);
    return { revision, path, records: rows.slice(0, size).map(r => ({
      changesetId: r.changesetId, path, operationPath: r.operationPath, role: r.role,
    })), total, truncated: total > size };
  }, { timeout: 300000 });
}
/** Complete, deduplicated impact by contributing author across all merge parents.
 * Summaries always include a revision once, even if reachable by multiple paths.
 * This is intentionally separate from first-parent-only cumulative metrics.
 */
export async function exactDagContributions(repositoryId: string, revision: string,
  limit: number, after = "") {
  return db.$transaction(async tx => {
    await stageDag(tx, repositoryId, revision, "devhub_walk_a");
    const rows = await tx.$queryRaw<{
      authorId: string; revisions: bigint; operations: bigint; distinctPaths: bigint;
      totalAuthors: bigint;
    }[]>`
      WITH impact AS (
        SELECT c."authorId", COUNT(DISTINCT c.id) AS revisions,
          COUNT(op."changesetId") AS operations
        FROM "devhub_walk_a" reachable
        JOIN "SourceChangeset" c ON c.id = reachable.id AND c."repositoryId" = ${repositoryId}::uuid
        LEFT JOIN "SourceFileOperation" op ON op."changesetId" = c.id
        GROUP BY c."authorId"
      ), changed_paths AS (
        SELECT c."authorId", COUNT(DISTINCT touched.path) AS "distinctPaths"
        FROM "devhub_walk_a" reachable
        JOIN "SourceChangeset" c ON c.id = reachable.id AND c."repositoryId" = ${repositoryId}::uuid
        JOIN "SourceFileOperation" op ON op."changesetId" = c.id
        CROSS JOIN LATERAL (VALUES (op.path), (op."previousPath")) touched(path)
        WHERE touched.path IS NOT NULL
        GROUP BY c."authorId"
      )
      SELECT i.*, COALESCE(p."distinctPaths", 0) AS "distinctPaths",
        COUNT(*) OVER () AS "totalAuthors"
      FROM impact i LEFT JOIN changed_paths p ON p."authorId" = i."authorId"
      WHERE "authorId" > ${after}
      ORDER BY "authorId" LIMIT ${limit + 1}`;
    const records = rows.slice(0, limit).map(r => ({
      authorId: r.authorId, revisions: Number(r.revisions),
      operations: Number(r.operations), distinctPaths: Number(r.distinctPaths),
    }));
    return { revision, records, nextCursor: rows.length > limit ? records[records.length - 1].authorId : null };
  }, { timeout: 300000 });
}

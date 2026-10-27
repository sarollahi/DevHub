import { db } from "../lib/prisma";
import { assertRepositoryPermission } from "../lib/authorization";
import { getCanonicalSnapshotPage } from "./canonical";
import { resolveRevision, runAuthorizedQuery } from "./query";
import { SourceControlError, type SourceActor } from "./contracts";
import { enqueueSearchObjects } from "../workers/search-indexer";

export type SearchMode = "path" | "content";
export type SearchResult = { path: string; objectId: string; mode: string; line?: number; excerpt?: string };
const scanBudget = 5_000; // bounded work per HTTP request, never a repository-size ceiling

export async function searchRepository(args: {
  repositoryId: string; actor: SourceActor; revision: string; mode: SearchMode;
  query: string; cursor?: string; limit?: number;
}) {
  const { repositoryId, actor, mode } = args;
  const query = args.query.trim();
  const limit = args.limit ?? 40;
  if (!["path", "content"].includes(mode) || query.length < 2 || query.length > 128 ||
    !Number.isSafeInteger(limit) || limit < 1 || limit > 100 ||
    (args.cursor && (args.cursor.length > 512 || args.cursor.includes("\\") || args.cursor.startsWith("/")))) {
    throw new SourceControlError(422, "INVALID_SEARCH", "A 2–128 character query, valid cursor and limit 1–100 are required");
  }
  await assertRepositoryPermission(actor, repositoryId, "source:read");
  const revision = await runAuthorizedQuery(actor, repositoryId,
    () => resolveRevision(repositoryId, args.revision));
  const records: SearchResult[] = [];
  let stale = false;
  let excluded = false;
  let scanned = 0;
  let lastScanned = args.cursor || "";
  let more = true;
  let stopOnLimit = false;
  // A single request scans at most 5,000 indexed paths. Rare search terms
  // continue with nextCursor instead of allocating a million-path manifest.
  while (more && scanned < scanBudget && !stopOnLimit) {
    const page = await getCanonicalSnapshotPage(repositoryId, revision, actor,
      Math.min(500, scanBudget - scanned), lastScanned);
    more = page.nextCursor !== null;
    if (!page.entries.length) break;
    scanned += page.entries.length;
    const hits = new Map<string, string>();
    if (mode === "content") {
      const ids = [...new Set(page.entries.map(entry => entry.objectId))];
      await enqueueSearchObjects(ids);
      const status = await db.sourceSearchDocument.findMany({ where: { objectId: { in: ids } },
        select: { objectId: true, state: true, excludedReason: true } });
      if (status.length < ids.length || status.some(record => record.state !== "SUCCEEDED")) stale = true;
      if (status.some(record => !!record.excludedReason)) excluded = true;
      const matches = await db.sourceSearchDocument.findMany({ where: {
        objectId: { in: ids }, state: "SUCCEEDED", textBody: { contains: query, mode: "insensitive" },
      }, select: { objectId: true, textBody: true } });
      for (const match of matches) if (match.textBody !== null) hits.set(match.objectId, match.textBody);
    }
    for (const entry of page.entries) {
      lastScanned = entry.path;
      const content = mode === "content" ? hits.get(entry.objectId) : undefined;
      if (mode === "path" && !entry.path.toLowerCase().includes(query.toLowerCase())) continue;
      if (mode === "content" && content === undefined) continue;
      try { await assertRepositoryPermission(actor, repositoryId, "source:read", { paths: [entry.path] }); }
      catch { continue; }
      let line: number | undefined;
      let excerpt: string | undefined;
      if (content !== undefined) {
        const match = content.toLowerCase().indexOf(query.toLowerCase());
        const before = content.slice(0, match);
        line = before.split("\n").length;
        const row = content.split("\n")[line - 1] ?? "";
        excerpt = row.length > 260 ? row.slice(Math.max(0, match - before.lastIndexOf("\n") - 90), 260) : row;
      }
      records.push({ path: entry.path, objectId: entry.objectId, mode: entry.mode, line, excerpt });
      if (records.length > limit) { stopOnLimit = true; break; }
    }
  }
  const nextCursor = records.length > limit ? records[limit - 1].path :
    more ? lastScanned : null;
  return { revision, mode, query, records: records.slice(0, limit), nextCursor,
    index: { state: mode === "path" ? "NOT_REQUIRED" :
      stale || more ? "INDEXING" : "READY",
      largeOrBinaryFilesExcluded: excluded, maxIndexedBytes: 256 * 1024,
      scannedPaths: scanned, partial: more } };

}

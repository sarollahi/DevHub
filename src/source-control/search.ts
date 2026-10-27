import { db } from "../lib/prisma";
import { assertRepositoryPermission } from "../lib/authorization";
import { getCanonicalSnapshot } from "./canonical";
import { resolveRevision, runAuthorizedQuery } from "./query";
import { SourceControlError, type SourceActor } from "./contracts";
import { enqueueSearchObjects } from "../workers/search-indexer";

export type SearchMode = "path" | "content";
export type SearchResult = { path: string; objectId: string; mode: string; line?: number; excerpt?: string };
const limitPaths = 10000;

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
  const snapshot = await getCanonicalSnapshot(repositoryId, revision, actor);
  if (snapshot.entries.length > limitPaths)
    throw new SourceControlError(413, "REPOSITORY_TOO_LARGE", "Search snapshot path limit exceeded");

  const candidates = snapshot.entries.filter(entry => entry.path > (args.cursor || "")).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const ids = [...new Set(snapshot.entries.map(entry => entry.objectId))];
  let stale = false;
  let excluded = false;
  const hits = new Map<string, string>();
  if (mode === "content") {
    await enqueueSearchObjects(ids);
    for (let offset = 0; offset < ids.length; offset += 400) {
      const group = ids.slice(offset, offset + 400);
      const status = await db.sourceSearchDocument.findMany({ where: { objectId: { in: group } },
        select: { objectId: true, state: true, excludedReason: true } });
      if (status.length < group.length || status.some(record => record.state !== "SUCCEEDED")) stale = true;
      if (status.some(record => !!record.excludedReason)) excluded = true;
      const matches = await db.sourceSearchDocument.findMany({ where: {
        objectId: { in: group }, state: "SUCCEEDED", textBody: { contains: query, mode: "insensitive" },
      }, select: { objectId: true, textBody: true } });
      for (const match of matches) if (match.textBody !== null) hits.set(match.objectId, match.textBody);
    }
  }
  const records: SearchResult[] = [];
  // Recheck path policies on every hit. Never return a total that includes denied paths.
  for (const entry of candidates) {
    const text = mode === "content" ? hits.get(entry.objectId) : undefined;
    if (mode === "path" && !entry.path.toLowerCase().includes(query.toLowerCase())) continue;
    if (mode === "content" && text === undefined) continue;
    try { await assertRepositoryPermission(actor, repositoryId, "source:read", { paths: [entry.path] }); }
    catch { continue; }
    let line: number | undefined;
    let excerpt: string | undefined;
    if (text !== undefined) {
      const match = text.toLowerCase().indexOf(query.toLowerCase());
      const before = text.slice(0, match);
      line = before.split("\n").length;
      const row = text.split("\n")[line - 1] ?? "";
      excerpt = row.length > 260 ? row.slice(Math.max(0, match - before.lastIndexOf("\n") - 90), 260) : row;
    }
    records.push({ path: entry.path, objectId: entry.objectId, mode: entry.mode, line, excerpt });
    if (records.length > limit) break;
  }
  const nextCursor = records.length > limit ? records[limit - 1].path : null;
  return { revision, mode, query, records: records.slice(0, limit), nextCursor,
    index: { state: mode === "path" ? "NOT_REQUIRED" : stale ? "INDEXING" : "READY",
      largeOrBinaryFilesExcluded: excluded, maxIndexedBytes: 256 * 1024 } };
}

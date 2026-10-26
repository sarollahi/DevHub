import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/prisma";
import { validPath } from "@/lib/review-logic";
import { requireRepositoryAccess, sourceFailure } from "@/source-control/http";
import { ancestryQuery, fileHistory, diffQuery, blameQuery, mergeQuery } from "@/source-control/query";
import { SourceControlError } from "@/source-control/contracts";

export const runtime = "nodejs";
const necessary = (value: string | null, field: string): string => {
  if (!value) throw new SourceControlError(422, "INVALID_QUERY", field + " is required");
  return value;
};
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string; operation: string }> }) {
  try {
    const { id, operation } = await params;
    await requireRepositoryAccess(request, id, "changesets:read");
    const q = request.nextUrl.searchParams;
    const path = q.get("path");
    if (path && !validPath(path)) throw new SourceControlError(422, "INVALID_PATH", "Invalid path");
    const revision = q.get("revision");
    const max = Math.min(100, Math.max(1, Number(q.get("limit") || 30)));
    let result: object;
    switch (operation) {
      case "ancestry": result = await ancestryQuery(id, necessary(q.get("left"), "left"),
        necessary(q.get("right"), "right"), max); break;
      case "history": {
        const head = necessary(revision, "revision");
        if (path) { result = await fileHistory(id, head, path, true, max); break; }
        const history = await ancestryQuery(id, head, undefined, max);
        const info = await db.sourceChangeset.findMany({ where: { repositoryId: id,
          id: { in: [history.revision, ...history.ancestors] } },
          select: { id: true, message: true, authorId: true, createdAt: true } });
        const byId = new Map(info.map(x => [x.id, x]));
        result = { ...history, records: [history.revision, ...history.ancestors].filter((x, i, a) => a.indexOf(x) === i)
          .map(x => byId.get(x)).filter(Boolean) };
        break;
      }
      case "diff": result = await diffQuery(id, necessary(q.get("from"), "from"),
        necessary(q.get("to"), "to"), max); break;
      case "blame":
        if (!path) throw new SourceControlError(422, "INVALID_PATH", "Path required");
        result = await blameQuery(id, necessary(revision, "revision"), path); break;
      case "merge": result = await mergeQuery(id, necessary(q.get("ours"), "ours"),
        necessary(q.get("theirs"), "theirs")); break;
      default: throw new SourceControlError(404, "NOT_FOUND", "Unknown query");
    }
    return NextResponse.json({ apiVersion: 2, ...result });
  } catch (error) { return sourceFailure(error); }
}

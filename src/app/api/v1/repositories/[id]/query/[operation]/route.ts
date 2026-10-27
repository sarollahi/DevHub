import { NextRequest, NextResponse } from "next/server";
import { requireRepositoryAccess, sourceFailure } from "@/source-control/http";
import {
  ancestryQuery, compareQuery, treeQuery, diffQuery, fileHistory,
  blameQuery, resolvePath, mergeQuery, rebaseQuery, pathImpactQuery,
} from "@/source-control/query";
import { SourceControlError } from "@/source-control/contracts";
import { runAuthorizedQuery } from "@/source-control/query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: {
  params: Promise<{ id: string; operation: string }>,
}) {
  try {
    const { id, operation } = await params;
    const { actor } = await requireRepositoryAccess(req, id, "changesets:read");
    const q = req.nextUrl.searchParams;
    const required = (name: string) => {
      const value = q.get(name);
      if (!value) throw new SourceControlError(422, "MISSING_PARAMETER", `Missing query parameter: ${name}`);
      return value;
    };
    const count = Number(q.get("limit") ?? 50);
    let result: unknown;
    return runAuthorizedQuery(actor, id, async () => {
    switch (operation) {
      case "ancestry":
        result = await ancestryQuery(id, required("revision"), q.get("other") ?? undefined, count);
        break;
      case "compare":
        result = await compareQuery(id, required("from"), required("to"));
        break;
      case "tree":
        result = await treeQuery(id, required("revision"), q.get("path") ?? "", count, q.get("cursor") ?? "");
        break;
      case "diff":
        result = await diffQuery(id, required("from"), required("to"), count, Number(q.get("offset") ?? 0));
        break;
      case "history":
        result = await fileHistory(id, required("revision"), required("path"), q.get("followRenames") !== "false", count);
        break;
      case "impact":
        result = await pathImpactQuery(id, required("revision"), required("path"), count);
        break;
      case "blame":
        result = await blameQuery(id, required("revision"), required("path"), count);
        break;
      case "resolve":
        result = await resolvePath(id, required("revision"), required("path"));
        break;
      case "merge":
        result = await mergeQuery(id, required("ours"), required("theirs"));
        break;
      case "rebase":
        result = await rebaseQuery(id, required("tip"), required("onto"));
        break;
      default:
        throw new SourceControlError(404, "UNKNOWN_QUERY", "Unknown source-control query");
    }
    return NextResponse.json({ apiVersion: 1, result }, {
      headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
    });
    });
  } catch (error) { return sourceFailure(error); }
}

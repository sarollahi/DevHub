import { NextRequest } from "next/server";
import { db } from "@/lib/prisma";
import { assertRepositoryPermission } from "@/lib/authorization";
import { requireRepositoryAccess, sourceFailure } from "@/source-control/http";
import { SourceControlError } from "@/source-control/contracts";

export const runtime = "nodejs";

// Never use a cache hit as proof of access. Every caller must authenticate to
// the authority; this HEAD endpoint returns no object bytes.
export async function HEAD(request: NextRequest, { params }: {
  params: Promise<{ id: string; objectId: string }>
}) {
  try {
    const { id: repositoryId, objectId } = await params;
    if (!/^[a-f0-9]{64}$/.test(objectId)) throw new SourceControlError(404, "NOT_FOUND", "Object not found");
    const { actor } = await requireRepositoryAccess(request, repositoryId, "changesets:read");
    const object = await db.sourceObject.findUnique({ where: { id: objectId }, select: { kind: true } });
    // Tree manifests may disclose restricted paths. Reject until scoped tree
    // authorization is supported, rather than trusting a repository read alone.
    if (!object || object.kind !== "BLOB") throw new SourceControlError(404, "NOT_FOUND", "Object not found");
    const references = await db.sourceFileOperation.findMany({
      where: { objectId, changeset: { repositoryId } },
      select: { path: true }, take: 100,
    });
    if (!references.length) throw new SourceControlError(404, "NOT_FOUND", "Object not found");
    let permitted = false;
    for (const { path } of references) {
      try {
        await assertRepositoryPermission(actor, repositoryId, "source:read", { paths: [path] });
        permitted = true;
        break;
      } catch { /* Keep evaluating paths; deny if none is visible. */ }
    }
    if (!permitted) throw new SourceControlError(404, "NOT_FOUND", "Object not found");
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  } catch (error) { return sourceFailure(error); }
}
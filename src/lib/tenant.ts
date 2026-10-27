import { db } from "./prisma";
import { assertRepositoryPermission, type Capability } from "./authorization";
import type { SourceActor } from "../source-control/contracts";

// Never query tenant-owned content with only a signed-in/session check.
// The second authorization pass applies explicit denials and path restrictions.
export async function permittedRepositoryIds(actor: SourceActor, capability: Capability = "source:read"): Promise<string[]> {
  const candidates = await db.repository.findMany({
    where: { OR: [
      { organizationId: null, ownerId: actor.id },
      { organization: { memberships: { some: { userId: actor.id } } } },
    ] },
    select: { id: true }, take: 1000,
  });
  const decisions = await Promise.all(candidates.map(async ({ id }) => {
    try { await assertRepositoryPermission(actor, id, capability); return id; }
    catch { return null; }
  }));
  return decisions.filter((id): id is string => id !== null);
}

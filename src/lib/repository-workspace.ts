import { notFound, redirect } from "next/navigation";
import { db } from "@/lib/prisma";
import { sessionIdentity } from "@/lib/auth";
import { assertRepositoryPermission } from "@/lib/authorization";
import { runAuthorizedQuery, resolveRevision } from "@/source-control/query";

export async function repositoryWorkspace(id: string) {
  const actor = await sessionIdentity();
  if (!actor) redirect("/login");
  try { await assertRepositoryPermission(actor, id, "source:read"); }
  catch { notFound(); }
  const repository = await db.repository.findUnique({
    where: { id }, select: { id: true, name: true, slug: true, defaultBranch: true,
      organizationId: true, owner: { select: { handle: true } } },
  });
  if (!repository) notFound();
  return { actor, repository };
}

export async function selectedRevision(repositoryId: string, revision: string, actor: Awaited<ReturnType<typeof sessionIdentity>>) {
  if (!actor) redirect("/login");
  try { return await runAuthorizedQuery(actor, repositoryId, () => resolveRevision(repositoryId, revision)); }
  catch { notFound(); }
}

export function boundedNumber(value: string | undefined, fallback = 50, max = 100): number {
  const number = Number(value ?? fallback);
  return Number.isSafeInteger(number) && number > 0 ? Math.min(number, max) : fallback;
}

export function validRelativePath(value: string): boolean {
  return value === "" || (value.length <= 512 && !value.startsWith("/") &&
    !value.includes("\\") && !value.split("/").some(part => !part || part === "." || part === ".."));
}

export function repoHref(id: string, page: string, values: Record<string, string | number | undefined> = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== "") query.set(key, String(value));
  return "/repositories/" + encodeURIComponent(id) + "/" + page + (query.size ? "?" + query : "");
}

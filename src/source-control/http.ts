import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { db } from "../lib/prisma";
import { requestIdentity, verifyBrowserOrigin } from "../lib/auth";
import { assertRepositoryPermission, canonicalCapability, consumeRequestQuota, type AccessTarget } from "../lib/authorization";
import { SourceControlError, type SourceActor } from "./contracts";
import { ObjectStorageError } from "../object-store/s3";

export async function requireRepositoryAccess(
  request: NextRequest, repositoryId: string, scope: string, adminOnly = false, target: AccessTarget = {},
): Promise<{ actor: SourceActor; ownerId: string }> {
  const actor = await requestIdentity(request);
  if (!actor) throw new SourceControlError(401, "UNAUTHORIZED", "Authentication required");
  if (adminOnly && actor.type !== "HUMAN") throw new SourceControlError(403, "HUMAN_REQUIRED", "Human session required");
  if (request.method !== "GET" && actor.type === "HUMAN" && !verifyBrowserOrigin(request)) {
    throw new SourceControlError(403, "INVALID_ORIGIN", "Browser origin mismatch");
  }
  const capability = canonicalCapability(scope);
  await assertRepositoryPermission(actor, repositoryId, capability, {
    ...target, allowStaging: capability === "changeset:write" && request.method !== "GET",
  });
  await consumeRequestQuota(repositoryId, actor);
  const repository = await db.repository.findUnique({ where: { id: repositoryId }, select: { ownerId: true } });
  if (!repository) throw new SourceControlError(404, "NOT_FOUND", "Repository not found");
  return { ownerId: repository.ownerId, actor };
}

export function sourceFailure(error: unknown) {
  if (error instanceof ZodError) return NextResponse.json({ error: "INVALID_INPUT", issues: error.issues.map(i => ({ path: i.path, message: i.message })) }, { status: 422 });
  if (error instanceof SourceControlError) return NextResponse.json({ error: error.code, message: error.message }, { status: error.status });
  if (error instanceof ObjectStorageError) return NextResponse.json({ error: "OBJECT_STORAGE_ERROR", message: error.message }, { status: error.status >= 400 && error.status <= 599 ? error.status : 503 });
  console.error("Source-control request failed", error);
  return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
}


// Read bounded JSON without allowing chunked requests to bypass size limits.
// Request.json() buffers arbitrary input before schema validation.
export async function readBoundedJson(request: Request, maxBytes: number): Promise<unknown> {
  if (!request.body) throw new SourceControlError(400, "INVALID_JSON", "Request body required");
  const reader = request.body.getReader();
  const buffers: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new SourceControlError(413, "REQUEST_TOO_LARGE", "Request exceeds JSON input limit");
      }
      buffers.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(buffers.map(chunk => Buffer.from(chunk))).toString("utf8")) as unknown;
  } catch {
    throw new SourceControlError(400, "INVALID_JSON", "Malformed JSON body");
  }
}

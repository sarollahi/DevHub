import { Prisma, type AgentIdentity } from "@prisma/client";
import { db } from "../lib/prisma";
import { createPullRequestInput } from "../lib/validation";
import { sha256 } from "../lib/review-logic";
import { assertRepositoryPermission } from "../lib/authorization";
import type { SourceActor } from "../source-control/contracts";

export class IngestError extends Error {
  constructor(public status: number, public code: string, message: string, public retryAfter?: number) { super(message); }
}
export async function ingestPullRequest(agent: AgentIdentity, actor: SourceActor, body: unknown, key: string) {
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(key)) throw new IngestError(400, "INVALID_IDEMPOTENCY_KEY", "Idempotency-Key must be 8 to 128 safe characters");
  const parsed = createPullRequestInput.safeParse(body);
  if (!parsed.success) throw new IngestError(422, "INVALID_INPUT", parsed.error.issues.map((i) => i.message).join("; "));
  const input = parsed.data;
  const requestHash = sha256(JSON.stringify(input));
  const [handle, slug] = input.repository.split("/");
  try {
    return await db.$transaction(async (tx) => {
      const repo = await tx.repository.findFirst({ where: { slug, owner: { handle } } });
      if (!repo) throw new IngestError(404, "REPOSITORY_NOT_FOUND", "Repository not found");
      await assertRepositoryPermission(actor, repo.id, "changeset:write", { paths: input.changedFiles, branch: input.targetBranch }, tx);
      if (input.nativeChangesetId) {
        const native = await tx.sourceChangeset.findFirst({ where: {
          id: input.nativeChangesetId, repositoryId: repo.id,
        }, select: { id: true } });
        if (!native) throw new IngestError(422, "UNKNOWN_NATIVE_CHANGESET", "Native changeset does not belong to the repository");
      }
      // Serialize admission per repository to enforce quotas during simultaneous bursts.
      await tx.$queryRaw`SELECT id FROM "Repository" WHERE id = ${repo.id}::uuid FOR UPDATE`;
      const existing = await tx.pullRequest.findUnique({ where: { agentId_idempotencyKey: { agentId: agent.id, idempotencyKey: key } } });
      if (existing) {
        if (existing.requestHash !== requestHash) throw new IngestError(409, "IDEMPOTENCY_CONFLICT", "Key is already associated with different content");
        return { item: existing, created: false };
      }
      const minute = new Date(Math.floor(Date.now() / 60000) * 60000);
      const bucket = await tx.ingressBucket.findUnique({ where: { repositoryId_agentId_minute: { repositoryId: repo.id, agentId: agent.id, minute } } });
      const perMinute = Math.max(1, Number(process.env.INGEST_PER_AGENT_PER_MINUTE || 120));
      if (bucket && bucket.count >= perMinute) throw new IngestError(429, "RATE_LIMIT", "Agent ingestion rate exceeded", 60);
      const total = await tx.pullRequest.count({ where: { repositoryId: repo.id, state: { notIn: ["MERGED", "CLOSED"] } } });
      const maxActive = Math.min(repo.maxActivePullRequests, Math.max(1, Number(process.env.MAX_ACTIVE_PRS_PER_REPOSITORY || 2000)));
      if (total >= maxActive) throw new IngestError(429, "REPOSITORY_BACKPRESSURE", "Repository has too many active pull requests", 60);
      await tx.ingressBucket.upsert({
        where: { repositoryId_agentId_minute: { repositoryId: repo.id, agentId: agent.id, minute } },
        create: { repositoryId: repo.id, agentId: agent.id, minute, count: 1 },
        update: { count: { increment: 1 } },
      });
      const item = await tx.pullRequest.create({ data: { repositoryId: repo.id, agentId: agent.id, idempotencyKey: key,
        requestHash, title: input.title, description: input.description, sourceBranch: input.sourceBranch,
        sourceSha: input.sourceSha, targetBranch: input.targetBranch, targetSha: input.targetSha,
        changedFiles: input.changedFiles, patch: input.patch, nativeChangesetId: input.nativeChangesetId,
      } });
      const job = await tx.queueJob.create({ data: { pullId: item.id, kind: "PR_PREFLIGHT", idempotencyKey: `PR_PREFLIGHT:${item.id}:1` } });
      await tx.outboxEvent.create({ data: { aggregateType: "PullRequest", aggregateId: item.id, kind: "PR_PREFLIGHT_REQUESTED",
        payload: { pullId: item.id, jobId: job.id, version: 1 } } });
      await tx.auditEvent.create({ data: { repositoryId: repo.id, actorType: "AGENT", actorId: agent.id,
        action: "pull_request.created", subjectId: item.id, metadata: { sourceBranch: item.sourceBranch, targetBranch: item.targetBranch } } });
      return { item, created: true };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 20000, maxWait: 20000 });
  } catch (error) {
    if (error instanceof IngestError) throw error;
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") throw new IngestError(503, "RETRY_TRANSACTION", "Concurrent ingestion conflict; retry with same key", 1);
    throw error;
  }
}

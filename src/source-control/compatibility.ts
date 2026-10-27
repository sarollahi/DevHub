import { type AgentIdentity } from "@prisma/client";
import { ingestPullRequest } from "../services/ingest";
import type { SourceActor } from "./contracts";

// Legacy patch-and-commit ingestion remains a compatibility boundary.
// Native source-control storage does not depend on external commit SHAs.
export async function ingestLegacyPullRequest(agent: AgentIdentity, actor: SourceActor, body: unknown, idempotencyKey: string) {
  return ingestPullRequest(agent, actor, body, idempotencyKey);
}

import { type AgentIdentity } from "@prisma/client";
import { ingestPullRequest } from "../services/ingest";

// Legacy patch-and-commit ingestion remains a compatibility boundary.
// Native source-control storage does not depend on external commit SHAs.
export async function ingestLegacyPullRequest(agent: AgentIdentity, body: unknown, idempotencyKey: string) {
  return ingestPullRequest(agent, body, idempotencyKey);
}

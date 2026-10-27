# Native changeset review

## Authority and lifecycle

The review worker loads immutable server changesets, actual parent manifests and verified file objects. It never trusts contributor patch text. Every new v1/v2 changeset inserts a SourceReview job atomically; migrations enqueue historical changesets.

Workers poll PostgreSQL with compare-and-set leases, retry with bounded exponential backoff, and record processing time, model confidence and priced token cost. Jobs fail after four attempts and may be retried via the authenticated API. An expired worker lease prevents a stale result from replacing the current result. No contributor code executes in the review process.

The fingerprint binds the parent identities and all touched paths to before/after objects, permissions and deletion state. Conservative changed-line intervals distinguish disjoint file edits from overlapping regions; binary and unknown-base edits use conservative full-file overlap. Potential credential material and access-control paths receive deterministic high-risk ratings that models cannot reduce.

Only the 120 most recent indexed candidates with matching fingerprints, top-level groups or paths are compared. The grouping UI prioritizes risk and relationships. This bounded strategy is not global vector search and can miss older proposals. Full parent snapshot reconstruction retains the native source engine's existing path/depth limits. A future derived-region index is needed before claiming unrestricted thousands-per-second comparisons.

## Human decisions

- GET /api/v2/repositories/{id}/reviews: paginated results and persisted aggregate metrics.
- GET /api/v2/repositories/{id}/changesets/{sha}/review: exact review record and findings.
- POST /api/v2/repositories/{id}/changesets/{sha}/review: body with expectedChangesetId matching the path and decision APPROVED or CHANGES_REQUESTED.
- POST /api/v2/repositories/{id}/changesets/{sha}/review/retry: admin retry for failed analysis.

Approval requires finished native analysis and successful integrity validation, and is always authenticated as a human owner and stored against a specific SHA-256 changeset. A new revision has a new ID and never inherits approvals. Existing owner-only source approval APIs remain for compatibility and remain revision-scoped. No model output grants permissions or bypasses repository reference protection.

## Optional model provider

Set DEVHUB_REVIEW_ENDPOINT and DEVHUB_REVIEW_MODEL to configure a TLS JSON chat-completions compatible endpoint. DEVHUB_REVIEW_API_KEY is optional for local endpoints. A separate DEVHUB_REVIEW_EMBEDDING_ENDPOINT and DEVHUB_REVIEW_EMBEDDING_MODEL enable vector similarity; both embedding values must be configured together. Input and output sizes are capped and requests time out. Source content remains local by default; DEVHUB_REVIEW_SEND_SOURCE=true explicitly opts in to sending bounded excerpts. Content that looks like a credential is excluded from excerpts, but repository path metadata is transmitted whenever a provider is enabled.

Operator-supplied DEVHUB_REVIEW_USD_PER_MILLION_TOKENS prices reported usage. A recorded zero does not prove the provider was free when the rate or usage is absent. Confidence is unreported unless the provider returns a value. Provider results are advisory; deterministic policy scoring is independent.

## Deployment and tests

Run npm run db:deploy, npm run db:generate, npm run worker:review, npm run typecheck, npm test, npm run test:integration, and npm run build. Database jobs are distinct from legacy Redis preflight workers. Stale external provider requests may consume tokens after lease expiry; configure upstream quotas and limit DEVHUB_REVIEW_CONCURRENCY.

Unit and database integration tests cover exact duplicates with different descriptions, same-file independent and conflicting regions, harmless and credential-sensitive content, model vector validation and mismatched revision approval attempts.

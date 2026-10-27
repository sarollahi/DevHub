# Native change integration

DevHub prepares immutable native changesets concurrently and serializes only the final atomic compare-and-swap update to an individual branch reference.

## Pipeline

1. An authorized contributor submits an immutable changeset and target branch with a stable request key. Admission is idempotent and bounded by repository quotas.
2. A worker leases the request. Work on different requests proceeds concurrently. Expired leases are recoverable; a final publish requires the exact lease token.
3. The worker finds one authoritative common ancestor and compares base, target and incoming immutable snapshots. Full-file SHA-256 identities and file modes determine changes. Conflicts have deterministic sorted paths and base/target/incoming identities.
4. A clean result produces a new immutable merge changeset with the observed branch revision as its first parent. No ref moves during this expensive preparation.
5. Existing isolated validation runners must produce signed successful evidence for the source revision, the merged-target snapshot, and the final merged-result snapshot. Every protected branch requires these stages. Review and approval decisions are exact-revision bound.
6. The final transaction rechecks current actor permissions, branch policies, ref generation and revision, all signed validation evidence, and human approvals for both source and result. It atomically increments the ref generation, writes ref mutation history and the outbox event, records audit history, and marks integration complete.
7. A competing ref update causes a bounded rebase/retry against its new immutable head, including fresh checks. Nonoverlapping UTF-8 line changes can be automatically reconciled after independent bounded object verification; ambiguous content and binary conflicts require explicit resolution. No two writers simultaneously publish into the same reference generation.

## Protected ref rules

- The legacy reference UPDATE API cannot bypass integration on existing protected refs. Force changes and deletion are forbidden for protected refs.
- Protected, high-risk, and unknown-risk changes require human approval for both the original and integrated changeset. Unsigned, incomplete, failed or stale checks fail closed.
- Policy changes and ref mutations coordinate on a single per-repository policy row, while expensive preparation has no repository-wide lock.
- Language-model review findings are advisory only. Agents may propose a new immutable resolution through the conflict API; they cannot grant themselves approval.

## Operation

Run migrations, review and validation workers, and `npm run worker:integration`. `INTEGRATION_CONCURRENCY` defaults to 6 and is bounded 1-32. Immutable container-image digests, disposable validation runners and signing keys are required for passing strict checks; see `docs/architecture/0003-disposable-execution-validation.md`.

## API

- `POST /api/v2/repositories/:id/integrations` with JSON `{ "sourceChangesetId": "<sha256>", "targetRef": "main", "requestKey": "stable-unique-key" }`
- `GET /api/v2/repositories/:id/integrations` and `GET /api/v2/repositories/:id/integrations/:integrationId` provide states, deterministic conflicts and audit events.
- `POST .../integrations/:integrationId/retry` reauthorizes eligible stalled or failed work.
- `POST .../integrations/:integrationId/resolve` accepts a new independently validated immutable resolution changeset and a unique request key.
- `POST .../integrations/:integrationId/revert` enqueues an inverse changeset against the current ref. It uses the same review, validation and CAS gate; historical changesets remain immutable.
- `POST` and `GET .../integrations/:integrationId/deployment` request/check exact revision pre-deployment validation readiness.
- `PUT /api/v2/repositories/:id/integration-policy` accepts targetRef, four validation-stage booleans and maxRetries (1–32). Human administration required. Protected refs cannot disable checks.

The light-themed `/merge-queue` UI supports requests, retries, conflict resolutions, reverts and pre-deployment checks.

## Trusted deployment execution

A signed deployment controller is used instead of executing arbitrary scripts inside the web process. An administrator configures `DEPLOYMENT_CONTROLLERS_JSON` with an HTTPS controller and repository allowlist, plus its HMAC key in a server-side environment variable. A human administrator submits `POST /api/v2/repositories/:id/deployments` with `integrationId`, `environment`, and `requestKey`. Start `npm run worker:deployment`. The worker rechecks the exact integrated branch revision and signed pre-deployment gate before dispatch; controllers must deduplicate deployment UUIDs and return signed receipts. Receipt callback: `POST /api/v2/deployments/:deploymentId/receipt`. See [deployment threat model](security/integration-threat-model.md).

## Explicit limitations

- Automatic content merging is limited to safely disjoint edits in bounded UTF-8 text; semantic equivalence, binary and rename ambiguity still require independent reviewed resolution.
- A durable controller dispatch/receipt system executes authorized deployment requests. Deployment succeeds only on a valid signed success receipt from the configured controller; external rollout availability and independent end-to-end controller testing remain deployment prerequisites.
- Initial protected/default-ref creation now requires `POST /api/v2/repositories/:id/refs/bootstrap`, a human administrator, completed review, exact approval, and authenticated signed validation tasks. Legacy protected CREATE is rejected.
- Incremental Git synchronization into an existing protected ref is rejected by the older direct-update path. Import into a nonprotected staging branch, then promote via integration.
- The included repeatable synthetic performance benchmark is not proof of production-scale end-to-end throughput. Independent penetration testing and production-like distributed load testing remain release gates.

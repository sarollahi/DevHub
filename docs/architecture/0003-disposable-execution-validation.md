# Disposable execution validation

Execution checks are **not** structural changeset integrity checks. Structural validation only confirms
stored objects and graph metadata. A PASSED executable check is tied to an exact immutable native
changeset, optional conflict-checked target snapshot, content-addressed file list, dependency-lock
state, six fixed recipes and OCI image digests. Legacy patch-only PRs cannot receive an executable
PASS merely because a metadata preflight succeeded.

## Architecture

- The web application authenticates tenants and inserts a pipeline with six tasks in PostgreSQL,
  transactionally with admission checks. It never starts untrusted builds.
- A dedicated \`npm run validation:runner\` process claims tasks using PostgreSQL
  \`FOR UPDATE SKIP LOCKED\`, per-tenant row locks, short leases and bounded concurrency.
  Redis is not required for execution scheduling. Expired leases are retried. Late output
  cannot change a superseded attempt because the lease token is compared on publication.
- The runner recreates the exact immutable snapshot from authorized, SHA-256 verified
  repository objects. When a target changeset is supplied, the candidate changes are
  applied to the target with conflict detection, and the combined tree is checked.
- Each fixed recipe executes in a **new disposable OCI container** with disabled networking,
  read-only root, read-only input mount, no capabilities, non-root user, resource limits,
  bounded writable tmpfs, no bind-mounted Docker socket and no production secrets.
  Images **must be preloaded and pinned by digest**. Runner hosts must not run web/database
  services and must not hold persistent cloud credentials. Use VM/microVM isolation rather
  than a shared privileged Docker daemon for high-risk public multi-tenant deployments.
- Output logs are chunked, authenticated through repository-scoped API access and limited
  to 4 MiB per attempt. Artifacts are restricted to ordinary files (no symlinks),
  2 MiB per file / 8 MiB per task, stored in PostgreSQL bytea with SHA-256 verification.
  This implementation has **bounded artifacts**, not unlimited S3-backed artifacts.
- Each terminal check result is Ed25519 signed by the isolated worker; the web tier receives
  only the verification public key. A cache hit is valid only for a previously signed PASS
  with an identical fingerprint including tenant, changeset, target, snapshot, dependency
  state, command, limits and image. Cache-reuse gets its own signed result and provenance link.
- Human review of legacy PRs requires linking a native changeset and passing all six
  current, signed checks. Metadata-derived statuses never satisfy this gate.

## Required configuration

Set on **API and runner**:
- \`VALIDATION_NODE_IMAGE\` pinned OCI image with Node, npm, shell and an offline dependency
  cache at \`/opt/npm-cache\`; \`npm ci --offline --ignore-scripts\` fails closed if a package
  is not present. Provide npm \`build\`, \`test\` and \`lint\` scripts.
- \`VALIDATION_SCAN_IMAGE\` pinned image with Trivy, a prebaked vulnerability database and
  misconfiguration policies. Trivy runs offline.
- \`VALIDATION_SECRETS_IMAGE\` pinned image with Gitleaks and \`/bin/sh\`.
- \`VALIDATION_SIGNING_PUBLIC_KEY\`: base64 of a trusted Ed25519 public PEM.

Set **only on runner hosts**:
- \`VALIDATION_SIGNING_PRIVATE_KEY\`: base64 of matching private PEM.
- \`VALIDATION_DOCKER_HOST\`: connection to an isolated Docker host. Docker needs no
  registry pulls during check execution.

Generate keys on a trusted host with \`openssl genpkey -algorithm ED25519 -out private.pem\`
and \`openssl pkey -in private.pem -pubout -out public.pem\`. Supply base64-encoded
contents through a secret manager; never commit private material. Rotate keys by staging
a fresh trusted public key; old signed results cease to be eligible for reuse until
revalidated. Treat the environment images and offline vulnerability database as
release artifacts that are updated and independently scanned. A zero network policy
means checks cannot fetch advisories live; stale offline databases are operational risk.

Optional quotas: \`VALIDATION_TENANT_MAX_PENDING\` (default 48 tasks),
\`VALIDATION_TENANT_RUNNING\` (default 2), and
\`VALIDATION_RUNNER_CONCURRENCY\` (default 2 per worker). Use separate hosts per
trust tier and monitor the backlog. Do not provision runner hosts that can contact
the production database through container networking.

## API

\`POST /api/v2/repositories/:id/validations\` accepts
\`{ "changesetId": "<sha256>", "targetChangesetId": null, "idempotencyKey": "<key>" }\`
with administrator or \`validations:run\` authority. Returns 202 and status location.
\`GET /api/v2/repositories/:id/validations?changesetId=...\` lists executions.
\`GET /api/v2/repositories/:id/validations/:runId\` returns check status and evidence.
\`DELETE\` at the same URL cancels active checks (administrator only).
\`GET /.../:runId/tasks/:taskId/logs?stream=1\` streams SSE log chunks.
\`GET /.../:runId/tasks/:taskId/artifacts/:artifactId\` downloads verified bytes.
All APIs require repository authorization. User-facing dashboard:
\`/repositories/:id/validations\`.

## Operational limitations

- PostgreSQL artifacts have explicit small limits; a future S3 transport is appropriate
  for large reports, trace exports and build outputs.
- Network-isolated checks require offline, prebuilt images and vulnerability feeds.
  Changes needing network integration must use separately reviewed, tightly scoped
  proxy policies; do not enable general outbound runner networking.
- The current immutable blob materializer is bounded by the source engine's object
  and snapshot limits; it is not a multi-gigabyte checkout service.
- Correctness assumes runner host isolation, protected image curation and protection
  of the signing private key. A compromised signing key invalidates trust in results.

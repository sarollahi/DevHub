# Secure Git interoperability gateway

The native changeset DAG, SHA-256 blobs, reference generations, validation policies, and audit log remain authoritative. Git objects, packs, and refs exist **only in a disposable derived cache** under `GIT_INTEROP_ROOT`. Git is never a second source of truth. The gateway updates its derived refs from native refs before each advertisement, fetch, or push. The exporter persists deterministic native-changeset-to-Git-SHA mappings and can reconstruct a lost cache. Git push ingestion stores raw commit bytes to preserve incoming signatures and SHA-1 identity across cache loss.

## Run

Apply Prisma migrations and generate the client, then launch the separate Node process:

```sh
npm ci
npm run db:deploy && npm run db:generate
mkdir -p /var/lib/devhub/git-cache && chmod 700 /var/lib/devhub/git-cache
GIT_INTEROP_ROOT=/var/lib/devhub/git-cache \
GIT_INTEROP_HOST=127.0.0.1 \
GIT_INTEROP_PORT=9419 \
GIT_INTEROP_TLS_TERMINATED=1 \
npm run git:gateway
```

Terminate TLS at a **trusted** reverse proxy and forward `/git/` to this local port. Never expose the process publicly over plaintext HTTP; only configure `GIT_INTEROP_TLS_TERMINATED=1` when the upstream and proxy-to-gateway network are secured. For localhost testing only, `GIT_INTEROP_ALLOW_INSECURE_LOCALHOST=1` allows cleartext. Run **one gateway process per cache root**, with private filesystem permissions and Git installed. Multiple gateway replicas require distributed coordination and shared cache consistency before being enabled.

Create a human Git credential by sending a same-origin authenticated POST:

```json
POST /api/v2/repositories/REPOSITORY_UUID/git-credentials
{"scopes":["source:read","changeset:write","ref:update"],"days":7}
```

The response returns `token` **once**. Git credentials expire in 1–30 days; list them using GET of the same endpoint and revoke by DELETE `/api/v2/repositories/:id/git-credentials/:credentialId`. The token never inherits broader privileges than its user; repository/team/path/branch denies, token scopes and revocation are rechecked at native enforcement time. Do not store this token in a remote URL. Use a trusted OS credential manager or `GIT_ASKPASS` and supply any username with the token as the HTTPS password.

```sh
git clone https://git.devhub.example/git/REPOSITORY_UUID.git
git -C REPOSITORY_UUID fetch origin
git -C REPOSITORY_UUID push origin HEAD:refs/heads/topic-branch
```

If the native default branch has not been created, use `git clone -b EXISTING_BRANCH` and configure HEAD after protected bootstrap. The gateway supports Git smart HTTP v0/v1 upload-pack and receive-pack. Fetch and clone use standard Git object packs; the exporter writes SHA-1 Git blobs, trees, and commits derived from native SHA-256 objects. No full native repository clone is needed in the client.

## Push admission

Git receive-pack uses quarantine object storage and a server-installed synchronous pre-receive hook. Requests are limited to **1–32 ref commands** and 2,000 newly imported commits. The hook validates every path, symlink, blob digest, tenant grant and short-lived credential before invoking the authoritative native policy engine.

All native reference changes in a push run in **one PostgreSQL transaction**. Any stale generation, forbidden ref, unsigned check, missing approval, or failed object verification rolls back the entire native ref batch, including audit events. Only a fully accepted batch may be reported as accepted by the Git hook. Run `git push --atomic` for all-or-nothing semantics in Git's **separate disposable cache** as well.

- Branch creation, fast-forward changes, deletion and restoration are supported; native tombstone versions and authorization still apply.
- Immutable tags can be created, but not edited or deleted.
- **Controlled non-fast-forward branches** require all of: an administrator-scoped Git credential, native `allowForce=true` for that unprotected branch, an exact observed-old-SHA lease, and an explicit 10+ character reason. Protected/default branches never accept forced changes. Non-fast-forward is **not** accepted just because the user passed `git push --force`.
- Direct Git fast-forwards onto existing protected branches require an already-completed independent review, human approval, signed validation of the exact new source/revision, and signed checks for the proposed new snapshot against the observed old target. The checks are verified under the final native reference transaction. No checks are fabricated or run in a receive hook. Bootstrap of a missing protected branch still uses the separately authorized native signed bootstrap API.

Example for an explicitly permitted force-with-lease, after inspecting the remote old commit and enabling the native branch policy:

```sh
OLD_SHA=$(git rev-parse refs/remotes/origin/topic)
git push --force-with-lease=refs/heads/topic:$OLD_SHA \
  -o "devhub-force-reason=Reviewed replacement for incorrect history" \
  -o "devhub-lease=refs/heads/topic:$OLD_SHA" \
  origin HEAD:refs/heads/topic
```

On rejection, native refs remain unchanged. Already staged immutable objects/changesets may be unreferenced; they do not grant any authority. If a network or Git cache write fails *after* the native transaction committed, native state still wins and the next gateway synchronization repairs derived refs. This is deliberately **not** a distributed two-phase commit across PostgreSQL and Git's cache. Inspect the authoritative native ref and fetch before retrying an ambiguous transfer.

## Scope and limitations

- Supports Git smart HTTP SHA-1 format. Git SHA-256 object-format repos, SSH transport, shallow/partial clones, Git LFS storage endpoints, submodules/gitlinks, and replace refs are unsupported.
- Branches and lightweight tags are exported. Imported annotated tags project as lightweight refs; annotation and tag signatures do not round-trip. Historical Git importer objects without retained raw commit bytes may be re-encoded with different Git SHAs; content and ancestry remain native-authoritative.
- Up to 32 Git refs and 2,000 newly imported commits per push; immutable tags remain non-rewritable. Direct creation of a protected branch stays under the native signed bootstrap flow. Protected pushes with missing evidence are rejected, not silently queued or merged.
- Filesystem path validation, content-size limits, and unsafe symlink checks stay enforced. Git commit authorship never grants DevHub permissions.
- Export reuses persistent Git identities and delta-based tree generation. A lost cache is regenerated from native contents and persisted mappings.
- The gateway serializes Git cache RPCs **per repository**, while native expensive validation and merge preparation stay concurrent. Production multi-replica coordination is not implemented. Native batch transaction semantics do not imply that a non-`--atomic` Git client has opted into atomic local-cache ref writes.
- An interrupted or ambiguous transport may leave committed native refs with stale disposable Git refs. Retry only after inspecting the authoritative native ref and fetching.

## Verification and performance

```sh
npm run typecheck
npm run test:integration
npm run bench:git-interop -- \
  --url=https://git.devhub.example/git/REPOSITORY_UUID.git \
  --native-server=https://devhub.example \
  --native-repository=REPOSITORY_UUID \
  --native-ref=main \
  --native-file=README.md \
  --native-cli=devhub \
  --iterations=50 --concurrency=8 --warmup=5 \
  --output=git-load-results.json
```

A load run collects p50/p95/p99/min/max/mean **independently** for Git clone/fetch, Git checkout, incremental Git fetch, sparse native metadata sync, and native hydration. It supports up to 100 measured iterations, 16 clients and 20 warmups. Optional `--max-p95-gitCloneFetch=10000`, `--max-p95-gitCheckout=5000`, and equivalent per-metric thresholds fail a load run when exceeded. Credentials are supplied via a trusted OS Git credential helper or `GIT_ASKPASS`, never URL literals. `DEVHUB_TOKEN` supplies native auth. The harness rejects plaintext non-loopback URLs. A Git full checkout and a sparse native hydration are *different workloads*: compare revision, path counts, byte volume, warm/cold cache and concurrency before drawing conclusions.

For controlled load against a deployed gateway, use the **Git interoperability benchmark** manual workflow with environment-protected credentials and a permitted test repository. Results are uploaded as JSON; do not aim load testing at a shared production tenant without an approved capacity window. Workflow CI integration tests use a temporary local gateway with PostgreSQL and object storage, exercising multi-ref atomicity, protected checks, force-with-lease, binary identity, merge ancestry, branch deletion/restoration, transport failures and stale races.

A real production-scale result cannot be claimed until the gateway is deployed and benchmark JSON is generated for that environment. This repository supplies a reproducible, auditable process rather than invented throughput figures.

Remaining rollout work includes multi-replica cache coordination, formal security assessment, production sizing/capacity approval, and compatibility tests across diverse Git clients.

# DevHub native scalability qualification

**Scope:** actual immutable source content and authoritative PostgreSQL, Redis and
S3-compatible object storage. The qualification gate deliberately reports
`INCOMPLETE` until *every required stage and workload* has independent
measured evidence. Passing the smoke job does **not** certify production scale.

## Running the implemented program

CI uses Node 22.18+, PostgreSQL 16 and Redis 7 with real native
`stageCanonicalBlob`, `createCanonicalChangeset`, derived-index workers,
review workers and ref CAS. It collects and uploads unmodified stderr/stdout,
native lifecycle JSON, durable DB measurements and `summary.json`.

```sh
docker compose up -d --wait
npm ci --ignore-scripts --no-audit --no-fund
npm run db:generate && npm run db:deploy
npm run qualification:smoke -- --output=artifacts/qualification/local-smoke
node --test tests/qualification.test.mjs
```

The regular GitHub workflow runs smoke automatically for feature branches and
pull requests into `develop`. Full scale is `workflow_dispatch` only, restricted
to the `devhub-performance-isolated` environment and a dedicated
`self-hosted,linux,x64,devhub-performance` runner. Configure the environment
variables/secrets shown in `.github/workflows/native-qualification.yml`. The
topology variable must describe **the deployed topology**, not blindly copy
`ops/qualification/topology.example.json`. An unverified manifest does not
constitute independent evidence that replicas exist.

```sh
# Run manually on an isolated, dedicated benchmark driver attached to test services.
export DEVHUB_QUALIFICATION_ISOLATED=YES
export DEVHUB_QUALIFICATION_APPROVAL=RUN_FULL_SCALE
export DEVHUB_QUALIFICATION_TOPOLOGY_FILE=/secure/path/observed-topology.json
npm run qualification:full -- --output=artifacts/qualification/full-01

# Selectively rerun one scenario; never call it a complete run.
npm run qualification:full -- --only=history-1000000 \
  --output=artifacts/qualification/full-retry-01
```

Full mode fails closed unless the topology declares two or more independent API,
index, validation and integration replicas. This checks the submitted manifest,
**not independent health or physical node identity**; capture node inventory,
service metrics, configuration hashes and failures separately. Keep each suite on
an isolated cluster with capacity quotas and locked-down object buckets. Never
execute fault drills on a production endpoint.

## What is measured and what is not

| Required workload | Driver | Qualification treatment |
| --- | --- | --- |
| 1,000 concurrent native submissions, 10,000 independent changesets | `bench:lifecycle`, full parameters | Checks real object grants, persisted immutable revisions, publication p50/p95/p99 and accepted throughput. Native in-process API, not multi-instance HTTP. |
| 100,000 consecutive revisions, target 1,000,000 | `qualification/seed.ts` and `scale.ts` | Real alternating BLOB content; checkpoint and historical snapshot integrity. 1M is a target, **not a claimed result**. |
| 100,000 and 1,000,000 path repositories | Same scale driver in paths mode | 4,000 real file operations per batch; verifies persisted file count and snapshot root. Same content can occur at different paths; distinct byte count is reported separately. |
| Concurrent indexing and review | `qualification/drain.ts` and `evidence.ts` | Executes actual worker functions and measures durable completions. Single-process drain is not a distributed throughput result. |
| Thousands of validation and integration jobs | `bench:lifecycle` admissions, `evidence.ts` durable audit | **Admission is not execution**. Only signed finished tasks and completed integration results count. Tenant quotas may legitimately reject burst submissions; record errors. |
| Hundreds of competing ref updates | `bench:integration:db`, `bench:lifecycle` | Exactly one CAS winner with stale generation; not equivalent to successful merges. |
| Native sparse checkout/hydration | Existing `benchWorkspaces` inside lifecycle | Small content-backed fixture only. Real native CLI and multiple-host counts require separate evidence. |
| Cold/warm regional caches | `cache:benchmark` | Local deterministic cache control is explicitly `NONQUALIFYING`; regional node measurements remain absent. |
| S3 upload/verified download | `storage:stress` | Isolated full mode streams and verifies 3 GiB, reports physical encoding, elapsed time, RSS. It is independent from the canonical inline BLOB workload. |
| Crash/restart, controlled network partition | Existing `fault-drill`, `network-partition`, `reconcile` scripts | **Not automatically certified**. Run with independently measured restart/outage schedule, then check durable recovery and no ref/object corruption. |

Source query latency comes from the existing source-query benchmark; historical
blame/diff/ancestry p50/p95/p99 need matching dedicated queries with persisted
artifacts. Existing derived, Git interoperability and related-review benchmarks
remain separate controls. Semantic retrieval quality must come from labeled
real-content fixtures with recall and false-positive counts; deterministic
embedding mock measurements do **not** prove provider quality.

An integration pipeline qualifies only when the real validation runner produces
signed completed records, the review completes, human/policy approval is
authoritatively recorded, integration reaches `INTEGRATED`, the ref update is
consistent with an authorized CAS, and the client verifies the new content
digest. Current full-mode scripts do not complete all these conditions and
therefore the aggregate must remain `INCOMPLETE` and exit nonzero. A new driver
must capture these linked identifiers and timestamps before certification.

## Evidence schema and thresholds

The bundle contains `manifest.json`, `summary.json`, every command's raw
`.stdout.log` and `.stderr.log`, lifecycle and worker JSON, path/history
`.jsonl` progress, and resumable checkpoints. A failed or timed-out workload
must retain its partial logs; do not replace it with an extrapolation. A process
exit code of zero is only **case success**; the certification result checks
mandatory stage and workload coverage separately.

Threshold logic in `scripts/qualification/core.mjs` requires at least three
**completed, matching** prior baseline runs (same workload and topology hash),
then derives an observed robust ceiling/floor from median and absolute
deviations. With missing, incompatible or failed baseline data, the result is
`UNBASELINED`/`INCOMPARABLE`, never PASS. Baselines should be established
from stable deployments, repeated under identical load generator capacity,
and complemented with environment-specific safety/integrity acceptance gates.

Collect as independent artifacts: physical DB read/write/WAL metrics, storage
GET/PUT/bytes/dedupe, driver and every worker/node CPU/RSS/disk, Redis queues
and retries, source query suboperation histogram, review retrieval recall,
signed validation task timings and cost, tenant-attributed runner CPU/network,
CAS retries, lease expiry and worker recovery time, per-layer client/node/
regional cache counters, and native client verified hydration bytes. Null and
missing fields are **not zero**.

## Current validated bounds and blocking gaps

The first smoke run on 29 Oct 2026 exercised 8 actual concurrent immutable
changesets and 12 additional independent changesets, with 21 persisted
revisions immediately after the independent phase; ref CAS had one winner and
seven rejected stale writers. It revealed a **qualification-audit error**:
the first implementation compared the *final* repository count to the count
*before* ancestry and monorepo fixtures. This was corrected to verify the
independent phase's exact count and final count's lower bound. Review and
indexing rows were QUEUED when first inspected; the added worker drain
now attempts to complete actual jobs before the durability audit. Full-scale
multi-node evidence was **not available** from that smoke run.

Known limits and investigation strategy:
- **PostgreSQL connection pressure:** 1,000 parallel publication calls can
  exceed the pool/primary capacity. Capture SQL saturation, lock waits and
  admitted/rejected counts; change bounded admission or pooling, then rerun.
- **Large histories/trees:** checkpoint processing may bottleneck on persisted
  snapshot nodes or object grants. Resume from the last verified checkpoint
  and measure statements, WAL volume, CPU, allocation, and file-count truth.
- **Validation storm:** tenant quota enforces a backlog cap. Rejection is not
  throughput success; test fair multi-tenant scheduling with worker capacity.
- **Hot reference:** only one stale-generation CAS may succeed. Correctness is
  required, and integration retries must use a fresh target and revalidation.
- **Review search:** database index performance and semantic retrieval quality
  need separate real-content, labeled measures and stable embedding providers.
- **Cache failure:** local synthetic cache hit rates cannot imply regional
  hit rates, failure recovery, or native client hydration correctness.
- **Rollback and partitions:** no production-equivalent failure-domain or
  rollback claim is made without recorded fault injection and reconciliation.

Do not delete the disposable repositories automatically: failures need
forensic inspection. Remove them only with an explicit audited cleanup plan.
Never publish signing keys, tokens, credentials, or raw source payloads in
qualification logs. Do not claim parity with another system from these results.

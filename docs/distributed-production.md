# Distributed production deployment and recovery

**Status:** validation runbook, not a production certification. No deployment,
failover, RPO, RTO, or inter-region recovery claim is valid without an archived
test on the actual topology. CI fault drills are isolated infrastructure checks.

## Authority and instance boundaries

- PostgreSQL is the **only source of truth** for immutable changesets,
  repository object grants, ref generations, policies, integration journals,
  signed validation evidence, and durable work. Use one writable PG primary
  (or a managed cluster that guarantees one writer and fenced promotion).
  Do not accept writes against a split-brain, asynchronous promoted primary.
- Scale Next.js API replicas without local session/ref authority. Put them
  behind an HTTP load balancer with shared configuration and signing keys.
  Probe `/api/health` for DB-backed readiness; the load balancer must stop
  routing writes on 503. This health check does **not** certify Redis, S3,
  or validation runner availability.
- Scale separate dispatcher, review, source-index, preflight, validation,
  deployment and integration workers as distinct processes. The database
  owns their work/lease state; Redis/BullMQ is a transport accelerator.
  Scale workers only after measuring database lock contention, queue wait,
  and tenant starvation. On SIGTERM stop acquiring tasks and allow active
  leases to complete or expire; never force an unsafe result publication.
- Run two or more Git gateway instances with **separate, private** on-node
  `GIT_INTEROP_ROOT` (0700). Do not share the Git directory over NFS.
  All Git refs/commits in that directory are disposable native projections.
  A PostgreSQL lease serializes sessions per repository across gateways;
  a pre-receive hook is issued a lease token; native ref batch CAS checks
  and locks the token within the same DB transaction. An expired/stolen
  session must fail and the user must retry. Git transfer bytes are observed,
  not a second write authority.
- Use Redis with persistence/HA for fewer delivery replays, not for safety
  of protected branches. S3-compatible object storage must provide read-after-
  write availability and verified content hashes before publication. Regional
  cache and node-local cache are disposable. Cache misses/outages must fall
  through to verified authoritative objects; do not let cache availability
  make a missing object count as present.
- Run collector/metrics services separately. Export process metrics per
  replica (distinct `instance`/pod label), and durable queue gauges from DB.
  Never add unbounded repository, actor, path, credential or commit labels.

### Admission and fairness

The database atomically increments per-actor, per-repository and tenant-wide
minute buckets. Admission rejects over-limit requests with HTTP 429; it does
not rely on replica-local counters. Integration/validation paths have their
own finite quotas and worker concurrency limits. **Global weighted fair
scheduling across every queue is not implemented**: FIFO/oldest-job order
can starve small tenants under a sustained high-volume tenant; completion of
the fairness scheduler and its mixed-tenant load test is a merge gate.

### Process startup and configuration

Apply schema with `npm run db:deploy` from a **single controlled migration
job** before starting updated replicas. Do not use `prisma migrate dev`
against production. Use identical `DATABASE_URL` target, `REDIS_URL`,
object storage, signing keys, policy configuration and OTLP export
configuration on all applicable pods. Git ingress requires HTTPS or a
trusted TLS termination layer; do not expose `GIT_INTEROP_TLS_TERMINATED=1`
to a bypassable public endpoint. Restrict object-store credentials to the
required bucket/prefix and isolate runner Docker privileges.

Start independently:
`npm run start`, `npm run dispatcher`, `npm run worker`,
`npm run worker:source-index`, `npm run worker:review`,
`npm run validation:runner`, `npm run worker:integration`,
`npm run worker:deployment`, `npm run git:gateway`.
Run at least two independent replicas for critical roles; deployment sizing
and live throughput must be measured before setting autoscaling thresholds.

## Rolling upgrades and migrations

1. Archive a restore point, list versions of all pods, and freeze destructive
   operations and irreversible migrations.
2. Apply additive *expand* migrations once: nullable lease columns and new
   usage/tenant tables are safe to add before new code. Do not remove schema
   fields while an old worker still uses them.
3. Upgrade API, Git gateway and workers in small batches; deploy exactly one
   Git gateway version at a time if hook semantics change. Verify readiness,
   outbox age and expired leases after every batch. If a worker is killed,
   allow its lease to expire and let the fenced successor reclaim it.
4. Keep the old binary compatible with the expanded schema until all pods
   converge. Apply destructive *contract* migrations only in a later,
   independently reviewed release. On rollback, roll back binaries first;
   never blindly reverse a migration that contains committed production data.

The new `GitGatewayLease` / index-worker lease tokens require the migration
to run **before** those binaries start. Until all gateway replicas understand
lease fencing, mixed-version Git write traffic is unsafe: pause Git push
ingress while upgrading.

## Database failover and write safety

If the DB primary or connection is unavailable, do not fall back to local
source-control writes, Redis, Git refs or regional cache. Reject or time out
new source writes; keep protected branches fail-closed. Explicitly fence the
old primary before promoting a new primary; verify no dual-writer window.
Use a synchronous standby when the desired RPO requires no acknowledged
transaction loss; asynchronous replication **does not guarantee RPO=0**.
After promotion re-establish connections, inspect ref journals and integration
CAS, then reconcile. A timeout after commit must be retried with the original
idempotency key, not a new mutation ID. Gateway sessions that lose their DB
lease are aborted and old Git caches reproject on the next session.

## Backup and disaster recovery

Back up PostgreSQL using a consistent base backup plus retained WAL/managed
PITR, including encryption, off-site replication, retention, restore-tested
credentials, and periodic immutable backup. Back up/version S3 objects and
metadata. Record the time boundary between PG snapshots and S3 contents:
referenced S3 objects must remain available for every recoverable DB
snapshot. Do not garbage-collect an object solely because the current primary
no longer references it while a retained backup still may. Back up signing
key versions and credential rotation data through a separate secure
secret-management process; do not put secrets in source control.

**Isolated restore drill**: provision new PG and object bucket with separate
credentials, restore matching points, migrate only after source verification,
run read-only checks, and validate a known immutable blob sample by complete
hash. Verify protected-branch policy, signed validation evidence, ref
generations, journals and outbox. Then re-enable dispatchers and ingress in
that order. Record measured data-loss boundary and elapsed restoration time
as evidence. Never claim RPO/RTO from a config value. Do not restore a prior
backup over a running authoritative cluster.

## Fault injection and recovery gates

The CI workflow runs real isolated PostgreSQL, Redis, MinIO containers;
service-stop tests and new Docker **network disconnect/reconnect** tests are
separate. Each network drill probes a distinct peer in the Compose network,
checks that the original container PID stays alive, verifies peers cannot
connect during isolation, and confirms peer connectivity after restoration.
Run with `DEVHUB_FAULT_DRILL=isolated-local-only` and
`node scripts/network-partition.mjs --service=db --seconds=3`.
Do **not** run against a production network. The JSON fault evidence is
uploaded as a workflow artifact, not made up in this document.

| Scenario | Required measurement and invariant |
|---|---|
| DB connection interruption | Request rejection, no unauthorized ref update, idempotent retry, reconciliation |
| PostgreSQL primary failover | Fencing of old primary, no dual writer, actual promoted replica, RPO/RTO |
| Redis restart or partition | Replayed durable jobs, duplicate suppression, final result count |
| S3 outage or partition | Ref publication blocked if object unverified, recovery of PUBLISHING state |
| Worker SIGKILL mid-validation/publication | Lease expiration, stale token rejection, replacement's signed result |
| API crash mid-CAS | Exactly one journaled mutation or safe idempotent retry |
| Regional cache outage and retry storm | No wrong blob, bounded origin load/retries, observed recovery |
| Two independent Git gateway pushes | Cross-replica lease exclusivity and ref CAS; stale advertisement rejected |
| Cross-service partition | No completed writes while authoritative evidence unavailable |
| Restore from PITR + S3 | Full referenced-object inventory, signed evidence, RPO and RTO |

These scenarios are **not all demonstrated by the CI workflow**. In
particular, primary failover, independent Git process concurrency,
region-to-region partitions, API crash mid-transaction, and a full PITR
restore require a dedicated multi-node test environment with external
fault-injection controls, logs and signed run identifiers.

## Reconciliation and observation

Run `npm run ops:reconcile -- --sample=100 --verify-external` to check
cross-tenant refs, ancestry, missing operation object rows, grants,
integrations, validation/index state, stale leases and outbox backlog.
It verifies only **sampled** S3 blobs and inline objects; this is **not**
a proof that every referenced object is accessible. For certification,
enumerate *all* reachable blob IDs, confirm S3 HEAD/GET and full content
hashes, compare against grants and published refs, and archive the output
with the matching database snapshot. Never auto-regrant legacy missing
object grants or silently repair an authoritative ref. Publication recovery
is separately opt-in with `--recover-publications`.

`npm run ops:usage` reports DB-accounted stored bytes, runner wall time
(not CPU), and measured Git transport ingress/egress; API bandwidth, S3
requests/bytes, cache traffic, actual per-tenant CPU and infrastructure
billing attribution are not yet measured. These omissions are a
production-accounting limitation, not zero usage.

Scrape `/api/ops/metrics` with a dedicated `OPS_METRICS_TOKEN`, track
queue age, expiring leases, request/error histograms, cache breaker status
and span-export drops. Use existing OTLP exporter and structured logs, but
end-to-end causal trace coverage across every queue, Git child process and
object store is **incomplete**. Avoid claiming full trace continuity.

## Release acceptance (must all pass before merging)

- Full head-SHA CI green, with archives of integration tests and isolated
  network-fault JSON, not simply a service restart.
- Two or more independently scheduled API/gateway/worker replicas tested
  concurrently against shared PG/Redis/S3 and externally injected partitions.
- Failure results satisfy: zero missing referenced objects (full inventory),
  zero unauthorized ref mutations, zero corrupt published bytes, no lost
  durable work, verified protected-branch fail-closed behavior.
- Measured recovery time/RPO under actual failover, restore from backup,
  mixed-tenant fairness/backpressure, nonduplicated outbox/validation results,
  per-tenant usage coverage and traces; known limits recorded in the PR.
- Explicit review of schema migrations, rollout and rollback commands,
  operational dashboards and on-call runbooks.

Leave the PR draft and unmerged while any item is absent.

### Quota bucket retention

Schedule `npm run ops:compact-admission -- --keep-hours=48` on a single
maintenance runner at least daily. The operation only removes expired
window counters and is safe across live API replicas; do not remove active
windows. Monitor table growth and database disk utilization.

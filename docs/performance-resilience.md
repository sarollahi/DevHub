# Performance, resilience, and observability

## Scope and boundaries

The native performance driver publishes **actual SHA-256 content-addressed BLOB records and immutable native changesets** via the production `stageCanonicalBlob` and `createCanonicalChangeset` paths. It exercises real PostgreSQL transactions, ancestry, source queries, optimistic ref CAS, and durable integration/validation admission. The existing `scripts/burst.ts` is a legacy **synthetic PR metadata** workload and must not be cited as native-source throughput.

This is a measurement program, not a performance claim. The code does not supply fabricated baseline numbers or a promise of consistency under untested failure modes. A completed workload must pass integrity assertions before being treated as evidence. All test repositories are retained for forensics; remove them only with an audited, explicit cleanup procedure. Never point the driver at production without explicit isolated-tenant approval and `DEVHUB_ALLOW_PERF_WRITES=yes`.

## Reproducible development topology

- Host or CI runner: Node.js 22.18+, Prisma 6.19, DevHub native service APIs and benchmark driver.
- PostgreSQL 16: the authoritative reference, changeset, object-grant, and queue-state database.
- Redis 7: BullMQ durable scheduling; validation and integration dispatch have their own PostgreSQL admission state.
- Local MinIO (S3 compatible): binary upload and streaming workload via `npm run storage:stress`. The native JSON changeset load uses inline `SourceObject` BLOB records and **does not measure S3 throughput**.
- Node cache: `src/cache/daemon.mjs` has `/v1/status` counters. Export them with `npm run ops:cache-exporter` when running a TCP-enabled cache, including cold and warm samples.
- Each worker process must be independently scraped/instrumented to attribute CPU, memory and latency. Process-local histograms in the Next.js instance are not a global aggregated SLO.

```sh
docker compose up -d --wait
npm ci
npm run db:generate && npm run db:deploy
npm run typecheck && npm test && npm run test:integration

# Repeat for warm/cold comparison; do not average different profiles.
npm run bench:lifecycle -- \
  --submissions=1000 --changesets=10000 --concurrency=1000 \
  --depth=900 --monorepo-paths=6000 --ref-writers=128 \
  --integration-jobs=400 --ci-jobs=0 --queries=100 --blobs=64 \
  --output=reports/lifecycle-local.json

npm run bench:source-query -- --depth=900 --width=32 --layers=20
npm run bench:integration:db
npm run cache:benchmark
npm run storage:stress
npm run ops:reconcile -- --sample=100 --verify-external
npm run ops:usage -- --limit=100
```

The `--submissions` first phase attempts 1,000 simultaneous native writes (one operation per changeset), and `--changesets` is the **total** independent native child workload, excluding root, ancestry, and monorepo fixtures. Every child references verified persisted real content. The full profile is deliberately manual (`.github/workflows/performance-resilience.yml` → Run workflow → scale), not a standard PR job; the smoke profile is run in normal verification CI. For ad-hoc smaller runs, decrease all sizes and concurrency together.

The driver records per-phase attempted/accepted/failure counts, real p50/p95/p99 of operation wall time, elapsed time, success/attempt throughput, PostgreSQL persisted count, snapshot path counts, exactly-one-winner CAS, CPU time and driver RSS. Percentiles are nearest-rank empirical quantiles; they are not confidence intervals or a throughput SLA. Driver CPU/RSS excludes PostgreSQL, MinIO, Redis, separate application processes and runners. Publication bytes are raw inline BLOB payloads, **not object-store network traffic**. `--ci-jobs` admits *real validation pipelines* only when immutable runner images are configured; queued is not executed. To measure end-to-end validation durations start disposable runners and report actual `startedAt` / `finishedAt` values from `npm run ops:usage`.

Core source-control limits currently include **1,024 first-parent replay depth, 10,000 paths per snapshot, 200 operations per changeset**, and 4 MiB per canonical inline BLOB. These are behavioral limits, not throughput samples. A benchmark that fails due to those limits must report the error, not silently truncate the graph.

## Telemetry

- `GET /api/ops/metrics` exports Prometheus operation counters, latency histograms, process CPU/RSS, and persisted queue, index, integration, validation and publication gauges. Require `OPS_METRICS_TOKEN` (32+ random characters) over an authenticated internal network. Missing or invalid tokens always return 404. Database collection failure returns 503 and should page via the scrape-availability alert.
- Native endpoint spans accept valid W3C `traceparent` and optionally export OTLP/HTTP JSON to `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` (full `/v1/traces` URL), with optional `OTEL_EXPORTER_OTLP_HEADERS_TOKEN`. Non-local exporters require HTTPS. The bounded, best-effort exporter drops failed batches, exposes a dropped counter, and is **not** a guaranteed audit log.
- Operation logs use JSON lines with timestamp, fixed operation name, status, duration and trace ID; raw source content, bearer tokens, paths, user IDs and exception messages are excluded. Existing component-specific logs are not yet fully migrated to this format.
- `GET /v1/status` on node-cache is the source of measured hit/miss, requests, coalescing and regional-breaker status. `ops:cache-exporter` converts those values to Prometheus. Cache stats must be collected separately for cold start, warm repeated workspaces, cache misses, and regional failures. Native-query LRU cache is independent of the node object cache.

**Local dashboards:**

```sh
export OPS_METRICS_TOKEN="$(openssl rand -hex 32)"
printf %s "$OPS_METRICS_TOKEN" > ops/observability/metrics.token
chmod 600 ops/observability/metrics.token
export GRAFANA_ADMIN_PASSWORD="set-your-own-strong-password"
# Serve the app so host.docker.internal from Docker can access port 3000.
npm run dev -- -H 0.0.0.0
docker compose -f ops/observability/compose.yml up -d
```

Prometheus: `http://127.0.0.1:9090`; Grafana: `http://127.0.0.1:3001`. The standalone cache exporter binds only `127.0.0.1:9109`; to scrape it from Docker use a proxy or configure a reachable internal interface and strong token authentication. Adjust scrape targets per real deployment, rather than assuming the supplied host addresses exist. Alert thresholds are provisional diagnostic triggers until real baseline distributions and a staffed incident policy exist. Provision an Alertmanager or managed alert receiver for delivery: **rules alone do not route notifications**. Limit telemetry retention, secure bearer secrets, and keep trace payloads free of credentials.

## Tenant accounting

`npm run ops:usage` reports repository and tenant identity, persisted `storedBytes`, changeset count, object-grant count, integration admissions, validation pipeline count, and completed runner **wall seconds** from durable records. Output is an administrative report, not a public metric. Shared content grants and cache hits prevent straightforward per-tenant physical byte attribution; wall seconds are not vCPU seconds. The current system does **not** capture billable per-tenant CPU, egress or per-region network cost, so monetary cost is intentionally not invented.

## Reconciliation, fault injection and recovery

`npm run ops:reconcile` checks cross-repository refs and parent edges, missing operation grants (legacy warning), hash/size of sampled inline BLOBs, and expired index/validation/publication leases. `--verify-external` streams and checks a bounded sample of READY S3 objects. `--recover-publications` explicitly invokes the existing idempotent expired-publication recovery function; without it the tool is read-only. Run it after worker crashes and partition healing and alert on non-zero integrity violations. Sampling is **not an exhaustive cryptographic audit**.

Against a disposable local Compose environment only:

```sh
DEVHUB_FAULT_DRILL=isolated-local-only npm run ops:fault-drill -- --service=redis --seconds=5
DEVHUB_FAULT_DRILL=isolated-local-only npm run ops:fault-drill -- --service=minio --seconds=5
DEVHUB_FAULT_DRILL=isolated-local-only npm run ops:fault-drill -- --service=db --seconds=5
```

The drill stops a real service, restarts it within `finally`, waits for Compose health, and runs reconciliation. If the host or process dies, restore manually with `docker compose up -d --wait` and rerun reconciliation. **A service stop is not a network partition**; to test partitions, interpose a dedicated fault proxy (e.g. one on the cache/upstream path), disable links for a measured interval, then restore and verify content/refs. Repeat on a standalone dedicated regional cache with breakers/retry-budget metrics, not the production network. Simulate worker `SIGKILL` only within a disposable environment with an active task, restart the worker, then assert lease reclamation and no stale signed validation acceptance. Cache region failure should never permit unchecked content or ref policy bypass.

**Recovery acceptance gates:** no missing canonical objects or dangling refs, unchanged ref generation unless an authorized compare-and-swap succeeded, no unauthorized path access, no corrupted bytes admitted by cache, leases can recover without an infinite retry storm, and tracked driver + DB + worker resources remain within configured limits. A successful smoke benchmark is not proof of all these gates.

## Evidence ledger

- This change introduces executable drivers, checks, telemetry, and deployment manifests. **No 1,000-concurrent / 10,000-changeset / fault-partition production measurements are asserted here.**
- Results must be attached as unedited benchmark JSON and logs with commit SHA, timestamp, runner size, worker count, PostgreSQL/Redis/MinIO topology and version, error counts, restart/fault schedule, and repeat count. The workflow uploads `lifecycle-evidence` artifacts.
- Known bottlenecks to investigate: O(depth) canonical snapshot replay (1,024 limit), O(path-count) full-tree replay for large monorepos, contention on hot ref CAS (correctly single winner), inline BLOB publication transactions, task admission limits, one-process in-memory query LRU, and cache cold-start upstream amplification.
- Pending production verification: 1,000-way burst and 10k full fixture on a deployed gateway, end-to-end actual CI runner durations, full-region cache outage, network partition and two-device recovery, repeated trials/confidence intervals, per-worker CPU/memory, independent object-store ingress/egress and per-tenant billable cost, automated alert routing.

Do not compare these results to unrelated source-control architectures unless run on identical workloads, topology and validation constraints.

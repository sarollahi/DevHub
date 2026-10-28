# Recursive derived-data computations

DevHub treats source changesets, parent edges, operations, object grants and immutable
snapshot roots as the **only authorities**. Index records, queue state, path postings
and jump pointers are disposable accelerators; they never grant access or affect
change publication, validation, merge authorization or object ownership.

## Computation contract

`src/source-control/derived-index.ts` defines six versioned computation types:

| Kind | Parent state | Own changeset | Result |
| --- | --- | --- | --- |
| ancestry | All parents | Ordered parent edges | Max generation, first-parent depth, binary lifting jumps, linearity |
| changed-paths | None | File operations | Unique-path count, operation count and digest |
| directory | None | Immutable snapshot root | Verified root identifier and availability |
| history | All parents | Operations and ancestry generation | Sparse changed-path postings, with explicit rename source roles |
| impact | Parent's impact | Operations and path summary | Per-change impact and first-parent cumulative work |
| blame | Parent's blame | Changed files and parent line state | Bounded sparse per-file immutable line origins, with explicit unavailable markers |

The computation interface is generic: a kind declares whether it needs parent
results, which same-revision computations must complete first, and a deterministic
`compute(context)` function. Computation input is always taken from server-side
changeset and operation records. There is no contributor-provided index payload.

Workers schedule parents and prerequisites rather than guessing completion order.
They claim a PostgreSQL lease with a UUID fencing token. A completed result,
checksum, jump rows and postings are published in **one transaction** if the
lease token is still current. Expired claims can be retried by another process.
PostgreSQL prevents modifying a `SUCCEEDED` record or updating a posting.
Per-version composite unique keys prevent duplicate authoritative results.

A result's SHA-256 checksum is computed over recursively canonicalized JSON.
Readers verify identity, kind, version, repository scope and checksum.
Corruption fails closed. Safe index version upgrades use a new version key;
they do not overwrite previously published output. For failed jobs, an operator
can call `requeueFailedDerived`; do not retry immutable corrupted results in
place. Rebuild a new version and leave the canonical data unchanged.

## Queries, complexity and limitations

For any fully indexed merge DAG, the ancestry index stores immutable nearest-merge
spine pointers and first-parent binary-lifting jumps. Exact reachability skips
long linear stretches and visits the merge vertices and their side-parent
branches. Exact merge-base discovery intersects the compressed first-parent
spines, removes ancestor candidates, and returns **all** lowest common ancestors
in criss-cross merges. Wide DAGs and missing or stale indexes use bounded-batch
nonrecursive graph staging (`src/source-control/dag-queries.ts`), not recursive
CTEs or full snapshot reconstruction. The temporary PostgreSQL work table
deduplicates reachable changesets and can spill to disk, while the application
reads at most 512 vertex IDs per step. Such cold walks still cost O(reachable
vertices); no sublinear promise is made for arbitrary merge topologies.

`operation=impact` uses the same exact staged ancestor closure and canonical
operation rows. `operation=contributions` groups by author across the **entire
reachable DAG**, deduplicates revisions reached through multiple parents,
and reports revision, operation and distinct changed-path counts. These
aggregate queries remain proportional to reachable source history; they do not
use recursive SQL or first-parent-only impact estimates. Incremental
`impact` metadata remains an advisory first-parent statistic.

`blameQuery` prefers persisted immutable changed-file provenance; it maps
unchanged lines to parent origins with exact LCS, including a linear-memory
implementation for large sparse edits. It serves bounded pages (`offset` and
`limit`) without revisiting historical changesets. Current worker limits are
16 MiB / 250,000 lines per indexed text file, 128 changed files and 500,000
processed lines per changeset. CPU-intensive diffs beyond the configured
50-million-cell bound remain explicitly unavailable; they are **not** assigned
guessed line origins. Cold small files retain the complete reference matcher,
but truncated histories no longer produce incomplete blame results. Large cold
files require completion of their derived job; overly large, binary or otherwise
unsupported files must be rejected explicitly instead of silently replaying a
bounded history.

File history still uses indexed changed-path postings and exact first-parent
membership checks, following rename edges. A 20,000-candidate guard can defer
to the canonical path query for unusually dense rename activity. That specific
path query is separate from DAG ancestry and impact computations.

Directories use existing immutable radix roots; they do not copy entire
snapshots into index rows. A missing snapshot root is marked unavailable;
a background index must not invent one. Historical v2 root migration is the
separate resumable process documented in
`docs/architecture/0005-scalable-snapshot-indexes.md`.

File-history and blame postings are sparse in changed paths, jump rows are logarithmic in first-parent depth, and query pages are bounded. Runtime and storage amplification are measured rather than inferred.

## Authorization and operations

The public route remains
`GET /api/v2/repositories/:id/query/:operation` and enforces
`requireRepositoryAccess(..., "changesets:read")` before entering
`runAuthorizedQuery`. `operation=impact` accepts `revision`, `path` and `limit`. The new
`operation=contributions` accepts `revision`, `limit` and `cursor` and
returns a paginated author summary. Blame accepts `offset` and `limit`. Internal acceleration helpers should **never** be exposed
directly as unauthenticated routes. Cross-repository derived lookups check
repository identity and immutable revision binding. Full object-content
authorization stays in the existing query and source services.

`npm run db:deploy` must precede enabling the source-index worker in a
deployment. `npm run worker:source-index` polls both existing jobs and new
derived jobs. Readers lazily enqueue missing indexes; active branch updates
eagerly enqueue primary kinds in the same transaction as the reference audit
and outbox event. A run of the existing backfill may be necessary for historical
revisions whose immutable snapshot roots are missing.

### Reproducible measurements

Prepare an isolated PostgreSQL/S3 test deployment and real changesets with
`npm run bench:snapshot-scale`. Repeat for 10,000 revisions, 100,000 revisions
and a larger run if available. Set the head and an actually changed path:

```sh
npm run bench:derived-index -- \
  --repository=<repository-uuid> --revision=<head-id> \
  --path=src/main.ts --samples=100 --limit=100 --passes=100000 \
  > reports/derived-100k.json
```

Record host resources, PostgreSQL version and storage, deployment topology and
the indexed head revision alongside the output. The benchmark queries real
PostgreSQL records and reports measured storage (table and secondary indexes),
indexed-job throughput, and p50/p95/p99 for warm ancestry, history and merge
base calls. It reports `cacheHitRatio` and `recoveryDurationMs` as `null`
because they are not measured by this harness. `completed: false` means
the allowed passes did not finish; cold latency is then only partial backfill
elapsed time, not an end-to-end cold-read result.

### Recovery and rollout

1. Apply schema migration, generate Prisma client, and deploy code and workers (derived index version 2).
2. Enqueue a handful of active heads and verify state transitions, index
   checksums, immutable posting counts and source-query parity.
3. Ramp throughput while monitoring queue depth, FAILED rows, lease expirations,
   PostgreSQL table/WAL growth and read latency.
4. For a stuck FAILED job, determine whether the underlying revision or object
   is corrupt before requeueing. Do not silently rewrite canonical data.
5. On algorithm changes, increment `DERIVED_VERSION` together with its
   auxiliary table versioning and recompute; old results remain non-authoritative.
6. Roll back code without dropping tables. Never delete reachable source objects.

No 10k/100k benchmark result or production fault-injection measurement is
included unless a real deployed database completes that workload.

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
| blame | Parent's blame | Change history | Provenance dependency marker; line mapping remains on-demand |

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

For a fully indexed **linear** history, first-parent ancestor tests use binary
lifting, O(log depth), rather than re-running a recursive SQL walk. File history
uses an indexed path-posting lookup, tests exact first-parent membership and
follows rename edges. A bounded scan cap falls back to the canonical SQL
reference query instead of publishing truncated or unsound results.
`blameQuery` uses the faster file-history lookup when ready; its existing
bounded line matcher is still the correctness implementation and may return
a truncated result on very large histories. **Persistent per-line origin
snapshots are not implemented by this framework yet.**

Merge-heavy graph reachability, criss-cross merge bases and path impact continue
to use the exact recursive reference implementation. The ancestry accelerator is
deliberately limited to purely linear lineages; the generic DAG job scheduler
itself supports multiple parents. The cumulative impact number is explicitly a
first-parent statistic, not a deduplicated entire-DAG contribution count.

Directories use existing immutable radix roots; they do not copy entire
snapshots into index rows. A missing snapshot root is marked unavailable;
a background index must not invent one. Historical v2 root migration is the
separate resumable process documented in
`docs/architecture/0005-scalable-snapshot-indexes.md`.

File-history postings are sparse (O(changed paths)), jump rows are O(log history
depth) per changeset, and worker batches and read-page sizes are bounded. The
posting scan has a 20,000-candidate guard, after which the canonical query is
used. This can still be expensive on cold and highly branched histories.
No unmeasured throughput or latency claim follows from asymptotic complexity.

## Authorization and operations

The public route remains
`GET /api/v2/repositories/:id/query/:operation` and enforces
`requireRepositoryAccess(..., "changesets:read")` before entering
`runAuthorizedQuery`. The addition `operation=impact` accepts `revision`,
`path` and `limit`. Internal acceleration helpers should **never** be exposed
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

1. Apply schema migration, generate Prisma client, and deploy code and workers.
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

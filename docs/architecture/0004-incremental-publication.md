# Incremental changeset publication

## Authority and identity

The canonical v2 changeset ID is unchanged: SHA-256 of repository, actor,
parents, description and ordered operations. The new root is **derived immutable
repository state**, not an alternative source of truth. Its ownership is established
by a (repository ID, changeset ID) relationship with a database-level guard.
Parent edges, operations, published objects, validation records, audit rows,
query-index jobs and publication events remain transactional and authoritative.

The new `SourceSnapshotNode` table stores canonical JSON radix nodes. Each ID
is SHA-256 of a domain-separated byte representation. Each node has up to
16 child edges indexed by hexadecimal UTF-8 path bytes; edges are compressed.
The `SourceSnapshotRoot` table maps one existing changeset to exactly one
root. Both tables reject UPDATE and DELETE. Root corruption, noncanonical
serialization, missing children and incorrect child counts fail closed.
Read clients cannot request arbitrary global nodes; access is mediated by
authorized repository changeset reads.

## Publication algorithm

1. Authorize the actor against the repository **and all paths**, including
   rename/copy sources.
2. Resolve the first parent's existing root by one repository-scoped lookup.
   A parent without a root enters the explicit one-time legacy materializer.
3. For each operation, look up the relevant paths directly. Ensure no file is
   an ancestor of another file; prefix existence is checked by index traversal,
   not by enumerating descendants.
4. Verify referenced staged blobs, modes and symlink targets through the
   existing object ownership and integrity checks.
5. Apply ADD, MODIFY, DELETE, RENAME, COPY or CHMOD with copy-on-write
   compressed radix updates, retaining all unaffected subtrees.
6. Insert only new nodes reachable from the final root. In one database
   transaction publish the changeset, its root, parents, operations, query
   indexing, review metadata, idempotency key, audit and outbox event.

No Git branch ref is advanced as a side effect of publication. Reference
updates retain independent atomic compare-and-swap and protection policies.
For merge changesets the first parent supplies the working tree; the remaining
parents supply ancestry, exactly as in the previous canonical writer.

With *k* changed paths and maximum encoded path length *L*, radix work is
O(k L) in the worst case and independent of total file count *N* and first-parent
history depth *H*. Node fanout never exceeds 16. Compression reduces typical
reads and writes substantially. The maximum snapshot cardinality is 2,000,000
paths. Max path and operation input limits remain enforced.

Publication never calls first-parent replay when the parent has a stored root.
Snapshot enumeration for whole-tree queries is O(N), by definition, but reads
the stored nodes instead of replaying H changesets.

## Migration and rollout

Run `npm run db:deploy` before deploying the writer. Existing changesets are
not rewritten and do not receive a guessed root ID.

Deploy the schema first, then the writer. Before moving heavy production
traffic, materialize frequently used historical heads through the authorized
API:

```
GET  /api/v2/repositories/:id/changesets/:changesetId/snapshot
POST /api/v2/repositories/:id/changesets/:changesetId/snapshot
```

GET returns `materialized: false` without replay. POST requires publication
permission; it reads the existing immutable history and atomically installs a
derived root, or verifies an already materialized root. Publication of a new
revision on an old first parent performs the same one-time operation. Multiple
materializers deduplicate identical nodes and converge on one root. A failure
rolls back changeset/root/event together. Retry is safe. A pre-existing v1 tree
is decoded and integrity-checked during migration. Existing v2 deltas replay
only as a compatibility fallback.

Historical histories are not rewritten or rebased. Validate representative
paths, binary hashes, symlink modes, executable bits and ancestry against the
pre-upgrade API output. Keep both API versions available during rollout.
The v1 writer still cannot extend a v2-only revision; use v2 for those parents.

Avoid first materialization inside a time-sensitive request for an exceptionally
large unmaterialized legacy history. Materialization currently executes as one
transaction, which can exceed application or database timeouts. A resumable,
bounded-batch maintenance job should be added before migrating repositories
whose historical replay cannot complete inside the maintenance window.

For rollback, stop new publication before rolling back application code. Do
not drop the snapshot tables while revisions written after the upgrade exist:
the prior delta writer may be unable to replay histories beyond its old caps.
Derived roots can coexist with v1/v2 historical revisions indefinitely.

## Evidence and benchmark protocol

`npm run bench:publication` uses actual v2 changesets against a deployed DB
and S3-compatible object store. It refuses missing or mismatched fixtures.
Provide `BENCH_ACTOR_ID`, `BENCH_CREDENTIAL_ID`,
`BENCH_PUBLICATION_CASES` (JSON array) and optionally `BENCH_SAMPLES`,
`BENCH_CONCURRENCY`, `BENCH_TOPOLOGY`, `BENCH_REPORT_PATH`.

Each fixture case contains:

```json
{"label":"1000/shallow","repositoryId":"<uuid>","parentId":"<sha256>","expectedFiles":1000,"editPath":"bench/edit.txt","expectedHistory":"shallow"}
```

Prepare six isolated, already-materialized parents: 1,000, 100,000 and
1,000,000 paths, each with shallow (depth <= 10) and deep (depth >= 1,000)
first-parent ancestry. This requires representative imported or pre-populated
repositories; the benchmark never pretends to generate a million-file fixture.
Run with one and with multiple concurrent agents, recording the server and DB
topology, storage tier, data distribution and worker count.

For each sample, only the actual one-file MODIFY publication is timed. The
result includes p50/p95/p99 latency, CPU user/system time, process peak RSS,
snapshot-node read/write SQL call counts, actual newly persisted node payload
bytes and node counts. Every persisted-byte sample originates in the same
transaction's audit record. SQL calls for authorization/audit and PostgreSQL
WAL/index overhead are **not** included in these node-only statistics.
Complete SQL query counts, database CPU and physical written bytes require
independent tracing (for example pg_stat_statements, WAL metrics and cgroup
measurements); the harness emits null instead of fabricating them.

To measure baseline cost, run the previous writer against its supported
legacy fixtures in an isolated environment using the same hardware and load
and retain raw output. The old 10,000-path v2 hard limit means its
100,000- and 1,000,000-file comparisons may be categorically unsupported.
Do not silently extrapolate.

Core integration tests cover branching, concurrency, idempotency, rollback,
cross-repository denial, v1 migration, tampering, symlinks, mode changes and
correctness of independent oracle snapshots. Before declaring production
scale, execute the full benchmark matrix plus worker interruption, database
failover, duplicate racing publishes, durable-outbox reconciliation and
orphan-node retention analysis in a nonproduction environment.

## Operational limitations

Nodes are immutable and currently retained; no unsafe best-effort garbage
collection is enabled. The one-time legacy materializer reconstructs older
snapshots and can be costly. End-to-end throughput depends on blob verification,
permission queries, transaction duration and PostgreSQL capacity, not solely
on radix-tree complexity. No production-scale latency or parity claim is
made until measured results are attached to the deployment record.

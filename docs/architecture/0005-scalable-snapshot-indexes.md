# Scalable snapshot indexes and resumable migration

## Canonical authority and compatibility

`SourceChangeset`, its ordered `SourceFileOperation` rows, first-parent ancestry and
server-side object ownership remain authoritative. A `SourceSnapshotRoot` is a
**derived, immutable** digest bound to an exact revision and repository. The
`SourceSnapshotNode` Merkle radix structure stores immutable, globally
content-addressed path subtrees and subtree file counts. A cached node is
validated against its SHA-256 domain-separated digest when loaded; traversed
child links are checked against their recorded subtree counts.

Root and node rows reject updates and deletes at the database level. No
mutable migration cursor, background index, cache, Git ref or worker result may
override the canonical history. Readers authorize the repository before
dereferencing a root and never expose arbitrary global node IDs.

The v1 full-tree API remains readable and can supply a verified legacy anchor.
Historical v2 revisions without an indexed root **fail closed** with
`SNAPSHOT_NOT_MATERIALIZED`. They no longer replay 1,024 or 100,000 ancestors
in a normal user request. The explicit backfill API builds roots incrementally.
Existing revision identities, ancestry, operation ordering, review decisions,
Git mappings and validation records are not rewritten.

## Indexed read behavior

The radix index is compressed over UTF-8 path bytes with up to sixteen child
edges per node. A path lookup visits only nodes on that path, bounded by its
encoded path length rather than snapshot cardinality.

`SnapshotTree.page(root, limit, cursor, directory)` enumerates a bounded
file page in UTF-8 byte order. `SnapshotTree.directory(...)` returns only
immediate children. When it encounters a directory, it computes the strict
upper bound for its byte prefix and seeks directly into the next sibling
subtree; even millions of descendants under one child do not need to be
materialized merely to list sibling directories.

The query API's directory listing and path resolution now use these operations
for rooted revisions. The v1 stored-tree fallback remains for compatibility.
To page the v2 snapshot file endpoint, use:

```text
GET /api/v2/repositories/:repo/changesets/:revision/tree?limit=200&cursor=&directory=
```

The response contains `entries` and a `nextCursor` (null at EOF). The
cursor is an actual returned path, not an offset; it remains stable for the
immutable revision. **The legacy unpaged endpoint remains supported** but
materializes all paths and is unsuitable for million-file snapshots. Clients
should transition to the paginated endpoint. No global materialized path map is
used for ordinary point queries.

Canonical v2 accepts up to 5,000 operations per published changeset, up from
200. Operations are inserted in groups of 250 within the same transaction as
tree nodes, root, parent edges, audit, review/validation metadata and outbox.
The incoming JSON body remains bounded at 8 MiB. This is a finite larger
batch, **not** an unlimited streaming API; multi-million-operation individual
changesets still require an upload/session protocol. v1 stays at its old limit.

## Resumable historical backfill

Schema deployment is mandatory before the code rollout:

```sh
npm ci
npm run db:generate
npm run db:deploy
```

An authorized operator uses the snapshot endpoint:

```text
GET  /api/v2/repositories/:repo/changesets/:revision/snapshot
POST /api/v2/repositories/:repo/changesets/:revision/snapshot?discover=512&apply=64
```

GET never rebuilds anything; it reports the root or checkpoint status.
POST requires publication rights. The first phase traverses *at most* 512
first-parent edges per request and durably stores each discovered step. It
stops at the nearest already rooted revision, a verified v1 immutable tree,
or the initial empty root. Each subsequent application step reconstructs only
one historical revision against its immutable parent's radix root.

**Each root and progress increment commit atomically.** A crash before
commit leaves both absent; a crash after commit leaves both durable.
On restart the operator resumes from the stored `discovered` and
`applied` counters. Competing builders use optimistic conditional updates:
a stale worker aborts its transaction rather than publishing a conflicting
root. Roots are verified for exact identity after insert. The migration's
mutable step table is never consulted by normal revision readers.

Automated operator client:

```sh
DEVHUB_URL=https://devhub.example DEVHUB_AUTH_TOKEN='<operator-token>' \
npm run snapshot:backfill -- --repository=<repository-uuid> --revision=<head-sha>
```

Do not log bearer tokens. Stop new writers before database rollback. Old
application versions cannot read revisions that depend on roots. Never drop
snapshot tables while those changesets exist. Backfill records can be
reconciled or retired after successful completion, but immutable roots and
reachable nodes must be retained. This PR does **not** implement destructive
reachability GC or prove that a node is unreachable across every root; it
deliberately refuses best-effort compaction deletes.

## Reproducible scale experiments

`scripts/bench-snapshot-scale.ts` uses real `createCanonicalChangeset`
publications and actual PostgreSQL/S3-backed objects, **not synthetic PR
metadata**. It needs a disposable repository and a staged, authorized blob
whose object ID is passed as `BENCH_OBJECT_ID`. Set:

```sh
export BENCH_REPOSITORY_ID='<uuid>'
export BENCH_ACTOR_ID='<uuid>'
export BENCH_CREDENTIAL_ID='<uuid>'
export BENCH_OBJECT_ID='<64-char digest>'

# 100,000 paths and consecutive v2 revisions:
npm run bench:snapshot-scale -- --paths=100000 --depth=100000 \
  --report=reports/100k.jsonl

# Target 1,000,000 paths and revisions, intentionally opt-in:
npm run bench:snapshot-scale -- --paths=1000000 --depth=1000000 \
  --progress-every=250 --report=reports/1m.jsonl
```

A run writes progress with the latest immutable head; interrupted runs can
restart using `--parent=<last-head> --start=<completed-revisions> --paths=0`.
For path fixture population, restart using the last population head and
the remaining path count only after checking that target paths are not
duplicated. Keep raw JSONL, DB and server logs, hardware topology, PostgreSQL
`pg_stat_statements` and WAL metrics with the report.

Each completed run prints revision count, true path count read from an
immutable root, real sampled publish/query latency, RSS and process CPU,
node-count delta and elapsed time. Reservoir quantiles over up to 2,048
samples are *estimates*. Detailed PostgreSQL statement count, WAL bytes,
database CPU and storage write amplification need external metrics and are
reported as `null`, never inferred.

Git importer now publishes a root in the same transaction as each imported
revision, and verifies sampled Git trees via streaming Git paths and indexed
native point lookups instead of replaying first-parent history. Direct SQL
fixture seeders (including the browser harness) must publish roots explicitly.

The integration test suite covers 300-operation changesets, keyset paging,
independent readers while backfill advances, immutable root consistency,
resuming interrupted migration and v1 compatibility. For additional
operational validation, inject process termination between POST calls,
database disconnects and corrupt/missing checkpoint nodes in an isolated
environment. Compare random historical revision hashes and modes with
canonical source objects before promoting the build.

**Evidence status:** no result from a 100,000- or 1,000,000-change run is
included in this change. Do not claim million-change success, throughput
or p99 latency until a completed run and raw report are attached to the PR.

## Remaining limitations

* The older all-entry review, validation, diff and search paths can still
  materialize O(N) snapshots; large-repo consumption requires their own
  paginated or streaming conversion.
* The ancestry and merge-base queries now run recursive reachability inside
  PostgreSQL, but callers explicitly requesting the entire ancestor list can
  still materialize O(history) rows. Large DAG walks require query planning
  and index tuning against million-revision fixtures.
* 5,000 operations are bounded but are not a multipart transaction/upload
  protocol. Blob validation and authorization costs may dominate large writes.
* Per-changeset checkpointing incurs durable write amplification. Native
  snapshots deduplicate unchanged subtrees, but full-node GC/compaction is
  intentionally absent pending formal reachability and concurrent-reader
  safety proofs.
* A completed million-file path workload and million-revision workload, with
  database WAL and throughput measurements, remain release gates.

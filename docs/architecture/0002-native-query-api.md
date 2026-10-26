# Native source-control query API (v1)

All endpoints below are **server-side**, scoped to a repository UUID, and protected by an administrator session/token or an active agent credential with `changesets:read`. Responses include `apiVersion: 1`. They never clone a repository, generate a Git commit, or update a reference. An unrecognized object/revision in another repository returns 404.

Base: `GET /api/v1/repositories/:id/query/:operation`

| Operation | Query parameters | Result |
| --- | --- | --- |
| `ancestry` | `revision`, optional `other`, `limit` | Ancestor identifiers and count; lowest common ancestor(s) if `other` provided |
| `compare` | `from`, `to` | Adds, deletes, modifications, exact-content renames and copies |
| `tree` | `revision`, optional `path`, `limit`, `cursor` | Direct files and subdirectories; cursor-based pagination |
| `diff` | `from`, `to`, optional `limit`, `offset` | Content-addressed changed files, binary markers, line patches with explicit truncation |
| `history` | `revision`, `path`, optional `followRenames`, `limit` | First-parent file history, optionally tracking explicit moves |
| `blame` | `revision`, `path`, optional `limit` | Per-line provenance for UTF-8 text, with truncation status |
| `resolve` | `revision`, `path` | File digest or directory presence at any revision |
| `impact` | `revision`, `path`, optional `limit` | Path changes across all parents; indexed once available |
| `merge` | `ours`, `theirs` | Non-mutating three-way merge result, conflicts, base |
| `rebase` | `tip`, `onto` | Non-mutating first-parent replay preview and conflicts |

`revision` accepts a 64-hex-character changeset digest or a repository reference name (e.g. `main`, `refs/main`). An array of multiple merge bases is returned for criss-cross ancestry. Three-way preview refuses ambiguous merge-base selection rather than silently choosing one.

For raw stored content use:
`GET /api/v1/repositories/:id/objects/:objectId/raw`.

This is authenticated binary response streaming in 64 KiB chunks, with an integrity-verified SHA-256 identity and ETag. The legacy v1 writer has a 256 KiB blob limit; v2 staging supports up to 4 MiB and PostgreSQL BYTEA backing. The endpoint is chunked but **not** end-to-end bounded-memory multi-gigabyte object streaming; that requires the independent object-storage replacement.

## Indexing and recovery

New changesets enqueue `SourceQueryIndexJob` **inside the same PostgreSQL transaction** as publication. Existing revisions are lazily enqueued when first queried.

Start the durable worker alongside the API:

```bash
npm run worker:source-index
```

The worker claims rows with a time-limited lease, computes parent generation numbers in topological order, materializes destination and source-side path touches, then transactionally marks an index complete. Concurrent workers cannot claim a live lease. After process loss, expired leases can be reclaimed; repeated index insertions are idempotent. After transient errors the job retries with bounded backoff; a permanently failed job remains inspectable with its error.

Canonical operations are always available as a fallback while indexing is pending or failed; the `impact` query returns equivalent results for cold and warm index states. The ancestry query is a recursive, duplicate-eliminating PostgreSQL walk with a reverse-parent B-tree index. This handles wide merge DAGs without exponential traversal of shared ancestors. No skip pointers are added without a measured benefit. Cached immutable tree reads use a 24-entry bounded LRU keyed by repository plus revision.

## Semantics and limits

- First-parent file history and blame use the first parent for merge commits. Full multi-parent attribution remains a separate feature.
- Exact digest matches detect renames/copies without false positives. Similarity-based detection for edited renames is not yet implemented.
- Merge preview performs safe object-level three-way resolution. Simultaneous divergent edits to one file yield a conflict, even when a text-level automatic merge might be possible. No conflict markers or changesets are written.
- Rebase preview supports 200 first-parent non-merge changesets. A conflict prevents publication; previews are not persisted.
- Text patches and attribution use a bounded exact line-correspondence algorithm (1.5 million comparison cells). Oversized comparisons report truncation.
- Ancestry and first-parent queries cap traversal at 100,000 revisions. Diff pages cap at 100 files; tree pages at 500 entries; blame defaults to 50 relevant changes.
- Legacy revisions use immutable stored tree manifests. Canonical v2 revisions resolve deltas on demand from the first-parent history. Tree, diff, merge, and blame on v2 can reconstruct full trees; metadata-only ancestry queries do not. Persistent sparse-tree acceleration remains unimplemented.
- Canonical v2 captures file modes, symlinks, and explicit COPY/RENAME/CHMOD operations; current comparison and merge previews focus on content digests and do not provide full mode-aware merge semantics. Existing v1 PUT/MOVE/DELETE operations remain supported.

## Verification and benchmarks

`tests/source-query.integration.test.ts` covers authenticated routes, exact-content Git rename comparison, independent DAG ancestry oracle, criss-cross merge bases, deterministic changeset comparisons, history/blame, non-mutating preview, indexed/fallback parity, and expired worker lease recovery. Randomized tree algebra checks are seeded and reproducible.

Real PostgreSQL deep-history and wide-DAG benchmarks:

```bash
npm run bench:source-query -- --depth=5000 --width=64 --layers=50
```

The benchmark creates actual changeset and parent rows, measures the native queries with `performance.now()`, verifies cardinalities and removes its temporary data. It prints JSON timing records for each topology. Record your hardware, PostgreSQL settings, and repeated run distributions before comparing performance claims; unmeasured estimates are not substituted for results.

# ADR 0002: Canonical delta publication

Status: Implemented in the v2 API.

## Decision

The native v2 changeset writer stores an immutable header, ordered parent links and changed-file operations only. A changeset can exist without a branch or reference update. The engine never creates Git commits. V1 retains full tree objects for historical compatibility; v2 does not persist tree snapshots.

Changeset identity is SHA-256 over the canonical JSON tuple consisting of protocol version 2, repository ID, authenticated actor identity, ordered parent IDs, description and ordered operations. Timestamp is allocated by the server on initial publication. The optional idempotency key is scoped to repository and actor and is never part of the content identity.

The first parent defines the base file state. Additional parents record the merge DAG. Merge resolution is explicit; parent content is not automatically merged.

## Transactional consistency

The header, parent edges, delta operations, structural validation, immutable publication event, audit record and optional retry key are all persisted within one PostgreSQL transaction. On an error, none of those changes become visible. UNIQUE constraints serialize competing writes to identical content IDs or retry keys, without a repository-wide lock.

SourceObject holds immutable SHA-256 blobs. SourceObjectGrant gives an individual repository permission to use a staged blob. Publication verifies the blob digest, byte count, accessibility, path transitions, file/directory collisions and valid ancestor relationships. The event log provides durable transactional publication events; it does not guarantee external delivery, commit-timestamp ordering or streaming cursors.

## Versioned API

The base URL is /api/v2/repositories/{repositoryId}:

- POST /objects: stage arbitrary bytes, represented by canonical base64; supports empty and binary objects.
- POST /changesets: atomically publish immutable file deltas, returning HTTP 201 for newly created or HTTP 200 for replay.
- GET /changesets and GET /changesets/{id}: list and retrieve committed metadata.
- GET /changesets/{id}/tree: transiently reconstruct a complete snapshot from first-parent deltas, without persisting another tree.
- GET /events: list committed publication events.

A publication body contains apiVersion: 2, parents, description, optional idempotencyKey, and operations. Operation kinds: ADD, MODIFY, DELETE, RENAME, COPY and CHMOD. For ADD and MODIFY, objectId references a previously staged SHA-256 blob. For RENAME and COPY, previousPath identifies the source. For CHMOD, mode is required.

Modes are 100644 (regular file), 100755 (executable file), and 120000 (symbolic link). Symbolic-link contents are valid UTF-8 repository-contained relative targets. Empty and non-UTF-8 binary files are valid regular BLOBs.

## Safety limits and compatibility

The current JSON object-staging API limits raw blobs to 4 MiB; no streaming or S3-compatible object API is claimed here. Changesets have at most 200 operations and 8 parents; on-demand snapshots have a limit of 10,000 paths and 1,024 first-parent links. Long-lived repositories need verified checkpoints or indexed path state without reverting to per-changeset tree copies.

The legacy v1 writer may only extend v1 parents; v2 may extend either v1 or v2 parents. Browser origin protection and repository-owner agent scopes are required on requests. Existing human-approval and reference compare-and-swap gates remain separate from creation. Structural validation is not a claim that code was executed, built, scanned or approved.

## Testing

The real PostgreSQL integration suite exercises branching and merge DAGs, seeded generated histories, concurrent independent publication, concurrent duplicate replay, idempotency conflict, binary and empty blobs, symbolic links, permission checks, orphaned staged objects, injected event-insert failures and recovery through a fresh database client.

Fresh-client reads demonstrate durability across client restarts. Tests do not yet simulate a physical PostgreSQL server crash or multi-gigabyte uploads; both remain required before those stronger guarantees can be claimed.

Run: npm ci; npm run db:generate; npm run db:deploy; npm run typecheck; npm test; npm run test:integration; npm run build.

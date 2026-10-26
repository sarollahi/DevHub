# Reference management API (v1)

DevHub references are small, mutable, repository-scoped pointers to **immutable native SourceChangeset IDs**. Creating a changeset never creates a branch, tag, or release pointer. PostgreSQL is authoritative; no Git commits or remote consensus service are required.

## Endpoints

All paths are prefixed with `/api/v1/repositories/{repositoryId}`. Reads accept an authenticated owner or an agent with `changesets:read` belonging to the same owner. Writes and policy changes require the authenticated human owner; browser-origin checking applies to cookie-authenticated mutations.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/refs` | List active refs with kind, generation and target |
| GET | `/refs?includeDeleted=true` | Owner-only listing including tombstones |
| GET | `/refs/{name}` | Read an active ref; supports slash-delimited names |
| PUT | `/refs/{name}` | Create or conditionally advance a ref |
| DELETE | `/refs/{name}` | Tombstone a non-protected branch/release pointer |
| POST | `/refs` | Restore a tombstoned pointer, never silently recreate it |
| GET | `/refs/history?name={name}&limit=100&beforeGeneration=N` | Paginated mutation journal for a named ref |
| GET | `/refs/events?limit=100` | Recent immutable repository ref-event journal (deduplicate by event ID) |
| GET | `/refs/policy?name={name}` | Effective named protection settings |
| PUT | `/refs/policy` | Set named reference protection settings (owner only) |

`name` is an application-level ref name, not a path on disk. The default branch uses its configured literal name (usually `main`). Prefixes `tags/` and `releases/` have immutable kind semantics `TAG` and `RELEASE`; remaining names are `BRANCH`. The kind cannot change after creation. Components reject traversal, `..`, lockfile suffixes and invalid characters. The static API segments `policy`, `history` and `events` are reserved at the top level.

## CAS requests and idempotency

Create-only, with **expectedGeneration null**:

```sh
curl -X PUT "$BASE/api/v1/repositories/$REPO/refs/branches/feature-x" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"changesetId":"<64-char-sha256>","expectedGeneration":null,"mutationId":"create-feature-x-1"}'
```

Advance an existing pointer:

```json
{
  "changesetId": "<new-64-char-sha256>",
  "expectedGeneration": 4,
  "expectedChangesetId": "<current-64-char-sha256>",
  "mutationId": "update-feature-x-5"
}
```

A successful mutation replies with `{ "apiVersion": 1, "ref": { "name", "kind", "changesetId", "generation", "deleted", "updatedAt" }, "eventId", "replayed" }`. The initial creation returns HTTP 201; updates and idempotent replays return 200. Client libraries should always assign and durably reuse `mutationId` when retrying *the same logical request*; a successful first call followed by a lost HTTP response then returns the original committed snapshot with `replayed: true`. Without an explicit ID, compatibility handlers generate one and stale retries are rejected rather than implicitly reapplying to a new version.

Only one current generation can win a conditional update. Mismatched generations, unexpected target IDs, existing refs on create, and stale requests return HTTP 409. The client must fetch the current ref, recompute the intended change and submit a **new** mutation ID and expected generation; the server never silently rebases or overwrites. Request IDs reused with different payloads return `MUTATION_ID_REUSED` (409).

### Delete and restore

```json
// DELETE /refs/branches/feature-x
{"expectedGeneration":5,"expectedChangesetId":"<current-id>","mutationId":"delete-feature-x"}
```

```json
// POST /refs
{"name":"branches/feature-x","changesetId":"<restore-target>","expectedGeneration":6,"mutationId":"restore-feature-x"}
```

Deletion increments generation and retains the old target plus a tombstone. A later attempt to create the same name with `expectedGeneration: null` fails; restore must present the tombstone's generation. Restoration may point to the last target or to an authorized fast-forward descendant.

### Policy

```json
// PUT /refs/policy
{"name":"branches/integration","protected":true,"allowForce":false,"allowDelete":false,"requireApproval":true}
```

- The repository's configured default branch is **always protected**. It cannot be force-updated or deleted; it always requires explicit owner changeset approval and fast-forward ancestry. Policy cannot relax this.
- Tags are single-publication **immutable pointers**: update, delete, restore and force are forbidden, even for the owner. A deleted-name re-creation is never possible.
- Protected refs forbid delete and force, require fast-forward ancestry and owner approval. Policy can protect any nondefault named ref.
- Other branches and release pointers also require a descendant target by default. Force requires an explicit admin-owned policy with `allowForce: true`, `force: true` in the request and a reason of at least ten characters. There is no implicit force on conflicts.
- The repository-wide `requireHumanApproval` gate applies to all target-setting operations. Per-ref `requireApproval` and protected/default requirements add restrictions but never remove repository restrictions.
- Every target-setting operation requires the target changeset to belong to the same repository and pass the existing integrity check. This integrity check is *not* a trusted CI result.

## Transactional guarantees and downstream events

A mutation's ref CAS, immutable `SourceRefMutation` record, `AuditEvent`, and `OutboxEvent` commit in one PostgreSQL transaction. The hot row is locked only for the duration of its own conditional SQL update; no repository-wide lock is held and unrelated refs can progress independently. Unique indexes enforce mutation ID uniqueness and monotonic per-ref generation. Deadlocks/serialization failures may be retried against the **same** expected version, but explicit CAS conflicts are never auto-retried.

After commit, the dispatcher publishes `source.ref.create/update/delete/restore` outbox events to the dedicated BullMQ queue `devhub-source-ref-events` with a stable event ID. It does **not** route them to PR preflight processing. Failed publication retains an outbox row for retry; consumers must treat delivery as *at least once* and deduplicate by `eventId`. Event payloads contain `repositoryId`, `name`, `action`, `kind`, old/new target IDs and generations, and `forced`. The journal and recent event feed are durable inspection surfaces. The queue is a delivery interface; downstream indexers and validation workers must separately implement their own processing and replay/repair behavior.

**History migration limitation:** pre-existing reference operations were not journaled individually. The migration writes a `BASELINE` snapshot for each existing ref, preserving its current generation and target and explicitly attributing it to migration; it does not fabricate historical actors or intermediate ref moves. All subsequent mutations are journaled atomically.

## Verification

```sh
npm ci
npm run db:generate
npm run db:deploy
npm run typecheck
npm run test:integration
npm run build
```

`tests/references.integration.test.ts` exercises a real PostgreSQL database: concurrent generation CAS, idempotent replay and conflicting retry payloads, default-branch protections, immutable tags, policy-authorized force, tombstone restores, journal consistency, 240 contending writers (bounded concurrent waves) and injected outbox-insert transaction failure with rollback and retry. Outbox delivery uses the existing dispatcher and Redis service; a green integration run demonstrates DB CAS safety but does not by itself benchmark multi-host throughput. No distributed consensus infrastructure has been added.

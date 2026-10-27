# Git-to-native repository migrations

The importer runs on the application host against a **local Git repository**, typically a pre-created bare mirror. It does not use Git as DevHub storage: Git commit objects are read and independently published as native SHA-256 content-addressed blobs, immutable changesets, ordered parent edges and native references.

## Setup

1. Set `GIT_IMPORT_ROOT` to an existing restricted directory accessible by the import worker and CLI. Restrict operating-system access to trusted administrators.
2. Place a complete Git repository beneath that directory, for example `git clone --mirror <trusted-source> $GIT_IMPORT_ROOT/example.git`. Perform remote fetches outside DevHub; HTTP API cannot fetch remote URLs.
3. Run database migrations and generate Prisma client using `npm run db:deploy && npm run db:generate`.
4. Start `npm run import:worker` as a supervised, long-running process for queued administrative operations.
5. Open `/repositories/<repository-id>/source/import` or use the CLI.

```sh
npm run import:git -- start <repository-id> example.git
npm run import:git -- inspect <job-id>
npm run import:git -- resume <job-id>
npm run import:git -- verify <job-id>
```

## Administrative API

Authenticated administrator endpoints:

- `POST /api/v2/repositories/:id/imports`, with `{"sourcePath":"example.git"}` to queue or discover an existing job.
- `GET /api/v2/repositories/:id/imports`, to list status and errors.
- `GET /api/v2/repositories/:id/imports/:jobId`, to inspect.
- `POST /api/v2/repositories/:id/imports/:jobId`, with `{"action":"resume"}` or `{"action":"verify"}`.

Mutations require a valid admin bearer token or same-origin admin session. All jobs are repository-scoped. A lease prevents concurrent workers from publishing the same migration. Expired leases may be resumed. The SHA-to-changeset mapping, author/committer identity and time zone, and job progress survive restarts. Repeated imports skip already committed source SHAs. Ref synchronization uses native CAS semantics; non-fast-forward branch movement, changed tags and native-owned ref conflicts fail rather than silently overwrite.

## Data and integrity

Git commit parent order, original author/committer timestamps and offsets, messages, executable bits, UTF-8 relative symlink data, empty/binary files, branch tips and tags are retained. Annotated tags resolve to target changesets and their original object SHA is in the audit event. Imported Git branch names become native branch names, and Git tags live under the native tags/ namespace. Reference publication uses authoritative owner-approved compare-and-swap validation and records audit and mutation events. First-parent file deltas are stored, not per-commit whole trees. Rename/copy equivalence is represented as file additions/deletions; file content and resulting trees are preserved. The importer refuses submodules and invalid or non-UTF-8 paths rather than silently dropping them.

Large files stream through the existing S3-compatible immutable object store, with compressed multipart uploads, content verification, bounded buffers and durable publication. Both the original Git blob SHA and the native SHA-256 are checked before mapping publication. The native streaming content API serves large blobs with integrity verification.

Each Git commit is published in one PostgreSQL transaction with its native changeset header, parent links, file deltas, mapping, validation row, audit event and publication event. Publishing cannot expose a partial commit. A resumed run checks changed source refs, and reruns integrity and history verification. Verification compares every reachable Git commit's ancestry, authorship and per-file deltas, checks every imported blob against native SHA-256, and reconstructs representative full first-parent trees to compare Git path, mode and content mappings. If verification fails the job is FAILED and **must not be advertised as complete**.

## Limits and operational caveats

- The source must be a non-shallow local Git repository. Git fetch/sync happens outside the worker. Branch tips may advance; the next incremental run imports their new ancestry.
- The existing native object store supports up to 100 GiB per file; paths remain limited to 512 UTF-8 characters and imports cap operations at 100,000 per Git commit.
- Native tree query APIs have their own depth and path limits; importer verification walks the native first-parent history independently. Import history itself does not persist full-tree snapshots.
- Git LFS pointers are imported as tracked pointer bytes; external LFS content requires a separate LFS-specific migration. Submodule gitlinks are rejected.
- Migration references are only applied after all reachable commits have been published. A crash during reference synchronization can leave some refs advanced; every move is idempotent and the resumed job finishes the remaining refs. No global cross-ref transaction is claimed.
- Verification compares the currently reachable local Git source. Archived/dangling commits that are not reachable from branches or tags are not imported.
- Configure a durable S3-compatible object store for the importer and main application. Local development and CI use MinIO.
- User authentication and authorization are separate from Git authorship. Historical Git commit authors do not acquire DevHub permissions by being named in imported metadata.

### Human authorization for imported refs

Publishing Git references requires an active repository-owner human session with review and reference-update permissions. Import jobs record the authorizing user and session identifiers. Revocation or expiry fails closed and reauthorization is required on resume. The CLI requires an active `GIT_IMPORT_SESSION_TOKEN` obtained from a normal signed-in session; the import worker never impersonates an administrator. The session identifier is stored without raw session secrets.

# Local development and verification

Prerequisites: Node.js >= 22.18, npm, Docker with Compose, and local ports 5432, 6379, 9000 and 9001.

```sh
cp .env.example .env
# Replace all placeholder credentials in .env with independent 32+ character secrets.
docker compose up -d --wait
# MinIO runs at 127.0.0.1:9000; minio-init creates devhub-objects.
npm ci
npm run db:generate
npm run db:deploy
npx prisma validate
npx prisma migrate status
npm run typecheck
npm test
npm run test:integration
npm run storage:maintain
npm run build
```

Run three processes (separate terminals): `npm run dev`, `npm run dispatcher`, `npm run worker`, and `npm run worker:review`. Use `npm run db:seed` to create the initial administrator-owned repository and an authenticated agent; the seed reads `BOOTSTRAP_AGENT_TOKEN` and stores only its digest. The HTTP health check is `GET /api/health`.

CI provisions real PostgreSQL 16 and Redis 7 services, applies checked-in migrations, runs the integration suite against both services, validates TypeScript, builds the application and boots the HTTP server. `npm ci` is the sole dependency installation path after the one-time lockfile bootstrap. The secret scan inspects committed history. A green build is not evidence of actual source-code execution or completed merges; the initial PR merge endpoint remains intentionally disabled until a native source-control coordinator exists.

Never commit `.env`, runtime credentials, DB exports or build output. Use separate secrets for production. Run `docker compose down` to stop the containers.


## S3 immutable object storage

POST /api/v1/repositories/{id}/objects requires Content-Type: application/octet-stream and changesets:write. Optional X-Expected-Object-Id checks the entire upload. The SHA-256 object ID is SHA256 of BLOB plus NUL plus raw bytes. The response records raw and encoded lengths as decimal strings. Repeated raw bytes return the same object ID. Publication only returns success after a gzip round-trip verification from staging, final copy, final verification and a durable READY record in PostgreSQL.

A changeset PUT accepts either dataBase64 (legacy) or the published objectId, not both. fileMode supports 100644, 100755 and 120000. Symlinks are stored as target bytes and never followed by the server. Empty blobs are accepted. GET /api/v1/repositories/{id}/objects/{objectId}/content streams bytes without base64; POST on the adjacent /verify endpoint rechecks integrity. The prior JSON GET remains available for small PostgreSQL objects.

Run npm run storage:maintain once, or npm run storage:maintain -- --loop under a process supervisor for five-minute recovery/garbage-collection passes. Staging cleanup starts after two hours; unreferenced READY blobs have at least 24 hours retention. Publication leases expire in two minutes. Referenced blobs are protected through PostgreSQL source-operation foreign keys. Uploads use 16 MiB multipart parts and bounded input/output buffers. Downloads enforce compressed and expanded size limits, inflation ratio and final hashes.

Production needs private S3 access, HTTPS, bucket backups/versioning, and monitoring of staging, PUBLISHING and DELETING queues. A streaming download may emit earlier chunks before an end-of-stream integrity mismatch; clients must validate the content SHA-256 response header and discard incomplete output. This implementation does not provide presigned direct-browser uploads, checkout of symlink targets, distributed tracing, resumable partial-client uploads, or a measured multi-region durability SLA. Run integration tests with real MinIO and PostgreSQL.


MinIO image distribution changed in September 2026: the retired Docker Hub images can no longer be pulled, and anonymous Quay downloads are also restricted. Local Compose and CI use Chainguard's actively built MinIO and client images. Chainguard's freely accessible tags float; pin an internally mirrored, verified digest when deploying production environments.


## Measured streaming checks

Run npm run storage:stress against a local development database and MinIO. The stress script creates a temporary repository and uploads, verifies, then downloads 3 GiB from a constant 64 KiB input buffer; it prints measured wall time, compressed bytes, peak process RSS and peak heap as JSON. It fails if measured peak RSS exceeds 512 MiB. Set STORAGE_STRESS_REPOSITORY_ID to a dedicated existing repository UUID to use that repository instead. The feature-branch PR verification executes this stress script; do not interpret CI timing as a production SLA.


## Verified CI measurements (26 October 2026)

Observed on a GitHub Actions Ubuntu 24.04 runner, Node.js 22.18, PostgreSQL 16 and an ephemeral MinIO container (workflow Verify, run 40383375730):

| Operation | Measured result |
| --- | --- |
| Raw binary streamed and re-read | 3,221,225,472 bytes (3 GiB) |
| Gzip bytes physically stored | 3,222,208,547 bytes (essentially incompressible sample) |
| Combined upload + verified download wall time | 158,345 ms |
| Peak Node process RSS | 226,992,128 bytes (216.5 MiB) |
| Peak Node process heap | 15,885,520 bytes (15.2 MiB) |
| Maximum multipart upload buffer | 16,777,216 bytes (16 MiB) |
| Final SHA-256 check and cleanup | Passed |

These are observations for one CI run, not an SLA or a guarantee of throughput in other deployments. Peak RSS does not include PostgreSQL or MinIO processes, OS filesystem cache, or other containers. The larger test uses a repeated cryptographically random 64 KiB chunk, which is not highly compressible over the 32 KiB deflate window. It measures network/storage pipeline buffering rather than independent random bytes for all 3 GiB.

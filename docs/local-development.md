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

Run three processes (separate terminals): `npm run dev`, `npm run dispatcher`, and `npm run worker`. Use `npm run db:seed` to create the initial administrator-owned repository and an authenticated agent; the seed reads `BOOTSTRAP_AGENT_TOKEN` and stores only its digest. The HTTP health check is `GET /api/health`.

CI provisions real PostgreSQL 16 and Redis 7 services, applies checked-in migrations, runs the integration suite against both services, validates TypeScript, builds the application and boots the HTTP server. `npm ci` is the sole dependency installation path after the one-time lockfile bootstrap. The secret scan inspects committed history. A green build is not evidence of actual source-code execution or completed merges; the initial PR merge endpoint remains intentionally disabled until a native source-control coordinator exists.

Never commit `.env`, runtime credentials, DB exports or build output. Use separate secrets for production. Run `docker compose down` to stop the containers.


## S3 immutable object storage

POST /api/v1/repositories/{id}/objects requires Content-Type: application/octet-stream and changesets:write. Optional X-Expected-Object-Id checks the entire upload. The SHA-256 object ID is SHA256 of BLOB plus NUL plus raw bytes. The response records raw and encoded lengths as decimal strings. Repeated raw bytes return the same object ID. Publication only returns success after a gzip round-trip verification from staging, final copy, final verification and a durable READY record in PostgreSQL.

A changeset PUT accepts either dataBase64 (legacy) or the published objectId, not both. fileMode supports 100644, 100755 and 120000. Symlinks are stored as target bytes and never followed by the server. Empty blobs are accepted. GET /api/v1/repositories/{id}/objects/{objectId}/content streams bytes without base64; POST on the adjacent /verify endpoint rechecks integrity. The prior JSON GET remains available for small PostgreSQL objects.

Run npm run storage:maintain once, or npm run storage:maintain -- --loop under a process supervisor for five-minute recovery/garbage-collection passes. Staging cleanup starts after two hours; unreferenced READY blobs have at least 24 hours retention. Publication leases expire in two minutes. Referenced blobs are protected through PostgreSQL source-operation foreign keys. Uploads use 16 MiB multipart parts and bounded input/output buffers. Downloads enforce compressed and expanded size limits, inflation ratio and final hashes.

Production needs private S3 access, HTTPS, bucket backups/versioning, and monitoring of staging, PUBLISHING and DELETING queues. A streaming download may emit earlier chunks before an end-of-stream integrity mismatch; clients must validate the content SHA-256 response header and discard incomplete output. This implementation does not provide presigned direct-browser uploads, checkout of symlink targets, distributed tracing, resumable partial-client uploads, or a measured multi-region durability SLA. Run integration tests with real MinIO and PostgreSQL.


MinIO image distribution changed in September 2026: the retired Docker Hub images can no longer be pulled, and anonymous Quay downloads are also restricted. Local Compose and CI use Chainguard's actively built MinIO and client images. Chainguard's freely accessible tags float; pin an internally mirrored, verified digest when deploying production environments.

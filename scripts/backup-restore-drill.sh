#!/usr/bin/env bash
set -Eeuo pipefail
# Real logical database + independent object-store restoration in isolated CI.
# A pg_dump restore proves consistency for this fixture, NOT WAL/PITR recovery.
[[ "${DEVHUB_FAULT_DRILL:-}" == "isolated-local-only" && "${NODE_ENV:-}" != "production" ]] ||
  { echo "Restore drill requires DEVHUB_FAULT_DRILL=isolated-local-only" >&2; exit 2; }
[[ "${DATABASE_URL:-}" == *"localhost:5432"* ]] || { echo "Refusing non-local DB" >&2; exit 2; }
mkdir -p artifacts/distributed-faults
work="$(mktemp -d)"
pg="devhub-restore-pg-$$"
minio="devhub-restore-object-$$"
cleanup() {
  docker rm -f "$pg" "$minio" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT INT TERM
started="$(date +%s)"
export OBJECT_STORE_ENDPOINT="http://127.0.0.1:9000"
export OBJECT_STORE_BUCKET="devhub-objects"
export OBJECT_STORE_REGION="us-east-1"
export OBJECT_STORE_ACCESS_KEY="devhub-local"
export OBJECT_STORE_SECRET_KEY="devhub-local-password-change-in-production"
npx tsx scripts/verify-all-objects.ts --output=artifacts/distributed-faults/inventory-original.json
docker compose exec -T db pg_dump -U devhub -d devhub -Fc > "$work/db.dump"
test -s "$work/db.dump"
docker run -d --rm --name "$pg" -p 127.0.0.1:55432:5432 \
  -e POSTGRES_USER=devhub -e POSTGRES_DB=devhub -e POSTGRES_PASSWORD=devhub \
  postgres:16-alpine >/dev/null
docker run -d --rm --name "$minio" -p 127.0.0.1:19000:9000 \
  -e MINIO_ROOT_USER=devhub-local \
  -e MINIO_ROOT_PASSWORD=devhub-local-password-change-in-production \
  cgr.dev/chainguard/minio:latest server /data >/dev/null
for i in $(seq 1 45); do
  if docker exec "$pg" pg_isready -h 127.0.0.1 -U devhub -d devhub >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$pg" pg_isready -h 127.0.0.1 -U devhub -d devhub >/dev/null
docker exec -i "$pg" pg_restore -U devhub -d devhub --no-owner --no-acl < "$work/db.dump"
# Separate S3 process and bucket: copy actual stored objects, not fixture mocks.
docker run --rm --network host --entrypoint /bin/sh cgr.dev/chainguard/minio-client:latest-dev -c '
  set -e
  until mc alias set old http://127.0.0.1:9000 devhub-local devhub-local-password-change-in-production >/dev/null; do sleep 1; done
  until mc alias set restored http://127.0.0.1:19000 devhub-local devhub-local-password-change-in-production >/dev/null; do sleep 1; done
  mc mb --ignore-existing restored/devhub-objects
  mc mirror --overwrite old/devhub-objects restored/devhub-objects
'
DATABASE_URL="postgresql://devhub:devhub@127.0.0.1:55432/devhub?schema=public" \
  OBJECT_STORE_ENDPOINT="http://127.0.0.1:19000" \
  npx tsx scripts/verify-all-objects.ts --output=artifacts/distributed-faults/inventory-restored.json
node --input-type=module <<'NODE'
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
const orig = JSON.parse(readFileSync("artifacts/distributed-faults/inventory-original.json", "utf8"));
const restored = JSON.parse(readFileSync("artifacts/distributed-faults/inventory-restored.json", "utf8"));
assert.equal(orig.status, "PASS");
assert.equal(restored.status, "PASS");
for (const field of ["inspectedObjects", "inlineObjects", "streamedExternalObjects", "verifiedRawBytes"])
  assert.equal(orig[field], restored[field], field + " changed on restore");
const result = { drill: "independent_pg_dump_and_s3_restore", status: "PASS",
  sourceObjects: restored.inspectedObjects, externalObjects: restored.streamedExternalObjects,
  verifiedBytes: restored.verifiedRawBytes,
  notice: "Logical dump + separate S3 replica, not WAL point-in-time recovery" };
writeFileSync("artifacts/distributed-faults/backup-restore.json", JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
NODE
echo "Restore drill elapsed seconds: $(( $(date +%s) - started ))"

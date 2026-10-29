#!/usr/bin/env bash
set -Eeuo pipefail
# A real PostgreSQL physical basebackup + archived-WAL LSN-target restore.
# This uses fresh isolated Docker volumes; never points at a live service.
[[ "${DEVHUB_FAULT_DRILL:-}" == "isolated-local-only" && "${NODE_ENV:-}" != production ]] ||
  { echo "Refusing PITR without isolated test guard" >&2; exit 2; }
mkdir -p artifacts/distributed-faults
suffix="$$"
net="devhub-pitr-net-$suffix"
primary="devhub-pitr-primary-$suffix"
recovered="devhub-pitr-recovered-$suffix"
archive="devhub-pitr-archive-$suffix"
backup="devhub-pitr-backup-$suffix"
restore="devhub-pitr-restore-$suffix"
started="$(date +%s)"
cleanup() {
  docker rm -f "$primary" "$recovered" >/dev/null 2>&1 || true
  docker volume rm -f "$archive" "$backup" "$restore" >/dev/null 2>&1 || true
  docker network rm "$net" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
trap 'status=$?; echo "PITR_DRILL_FAILED line=$LINENO command=$BASH_COMMAND code=$status" >&2; docker logs --tail 50 "$primary" >&2 2>/dev/null || true; docker logs --tail 50 "$recovered" >&2 2>/dev/null || true; exit "$status"' ERR
docker network create "$net" >/dev/null
for vol in "$archive" "$backup" "$restore"; do
  docker volume create "$vol" >/dev/null
  docker run --rm -v "$vol":/data postgres:16-alpine sh -c 'chown -R postgres:postgres /data' >/dev/null
done
docker run -d --name "$primary" --network "$net" --network-alias pg-primary \
  -p 127.0.0.1:15432:5432 -v "$archive":/wal \
  -e POSTGRES_USER=devhub -e POSTGRES_DB=devhub -e POSTGRES_PASSWORD=devhub \
  postgres:16-alpine -c wal_level=replica -c max_wal_senders=8 \
  -c archive_mode=on -c 'archive_command=cp %p /wal/%f' >/dev/null
for i in $(seq 1 45); do
  if docker exec "$primary" pg_isready -h 127.0.0.1 -U devhub -d devhub >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$primary" pg_isready -h 127.0.0.1 -U devhub -d devhub >/dev/null
docker exec "$primary" psql -U devhub -d devhub -v ON_ERROR_STOP=1 \
  -c "CREATE ROLE replication_test WITH REPLICATION LOGIN PASSWORD 'local-pitr-test-password';" >/dev/null
docker exec "$primary" sh -c \
  "echo 'host replication replication_test 0.0.0.0/0 scram-sha-256' >> /var/lib/postgresql/data/pg_hba.conf"
docker exec "$primary" psql -U devhub -d devhub -c "SELECT pg_reload_conf()" >/dev/null
# Establish a real basebackup BEFORE publishing the native object fixture,
# so recovered database must replay WAL to recover the authoritative changeset.
docker run --rm --network "$net" --user postgres -v "$backup":/backup \
  -e PGPASSWORD=local-pitr-test-password postgres:16-alpine \
  pg_basebackup -h pg-primary -U replication_test -D /backup -Fp -Xs -P >/dev/null
DATABASE_URL="postgresql://devhub:devhub@127.0.0.1:15432/devhub?schema=public" \
  npx prisma migrate deploy >/dev/null
DATABASE_URL="postgresql://devhub:devhub@127.0.0.1:15432/devhub?schema=public" \
  npx tsx scripts/restore-fixture.ts >/dev/null
docker exec "$primary" psql -U devhub -d devhub -v ON_ERROR_STOP=1 \
  -c "CREATE TABLE public.pitr_boundary (id integer PRIMARY KEY, marker text NOT NULL);" \
  -c "INSERT INTO public.pitr_boundary VALUES (1,'included-before-target');" >/dev/null
target_lsn="$(docker exec "$primary" psql -U devhub -d devhub -Atc 'SELECT pg_current_wal_lsn()')"
[[ "$target_lsn" == */* ]] || { echo "Missing WAL target LSN"; exit 1; }
docker exec "$primary" psql -U devhub -d devhub -v ON_ERROR_STOP=1 \
  -c "INSERT INTO public.pitr_boundary VALUES (2,'excluded-after-target');" >/dev/null
docker exec "$primary" psql -U devhub -d devhub -c "SELECT pg_switch_wal()" >/dev/null
# The archive must contain WAL emitted after the target before source failure.
for i in $(seq 1 40); do
  count="$(docker run --rm -v "$archive":/wal postgres:16-alpine sh -c 'find /wal -type f | wc -l')"
  if [[ "$count" -ge 1 ]]; then break; fi
  sleep 1
done
[[ "$count" -ge 1 ]] || { echo "No WAL archived"; exit 1; }
docker stop "$primary" >/dev/null
# New independent volume, separate container and TCP listener.
docker run --rm -v "$backup":/backup -v "$restore":/data postgres:16-alpine \
  sh -c 'cp -a /backup/. /data/ && chown -R postgres:postgres /data' >/dev/null
{
  printf '%s\\n' \
    "restore_command = 'cp /wal/%f %p'" \
    "recovery_target_lsn = '$target_lsn'" \
    "recovery_target_inclusive = on" \
    "recovery_target_action = promote"
} | docker run --rm -i -v "$restore":/data postgres:16-alpine \
  sh -c 'cat >> /data/postgresql.auto.conf && touch /data/recovery.signal && \
    rm -f /data/standby.signal && chown postgres:postgres /data/recovery.signal /data/postgresql.auto.conf'
docker run -d --name "$recovered" --network "$net" -p 127.0.0.1:15433:5432 \
  -v "$restore":/var/lib/postgresql/data -v "$archive":/wal \
  postgres:16-alpine -c archive_mode=off >/dev/null
for i in $(seq 1 55); do
  if docker exec "$recovered" pg_isready -h 127.0.0.1 -U devhub -d devhub >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$recovered" pg_isready -h 127.0.0.1 -U devhub -d devhub >/dev/null
included="$(docker exec "$recovered" psql -U devhub -d devhub -Atc \
  "SELECT COUNT(*) FROM public.pitr_boundary WHERE id=1")"
excluded="$(docker exec "$recovered" psql -U devhub -d devhub -Atc \
  "SELECT COUNT(*) FROM public.pitr_boundary WHERE id=2")"
[[ "$included" == 1 && "$excluded" == 0 ]] ||
  { echo "PITR boundary violated: included=$included excluded=$excluded"; exit 1; }
[[ "$(docker exec "$recovered" psql -U devhub -d devhub -Atc 'SELECT pg_is_in_recovery()')" == f ]] ||
  { echo "Recovered instance is not promoted writable"; exit 1; }
DATABASE_URL="postgresql://devhub:devhub@127.0.0.1:15433/devhub?schema=public" \
  npx tsx scripts/verify-all-objects.ts --output=artifacts/distributed-faults/pitr-inventory.json
node --input-type=module - "$target_lsn" "$(( $(date +%s) - started ))" <<'NODE'
import { writeFileSync, readFileSync } from "node:fs";
const [, , target, elapsed] = process.argv;
const inventory = JSON.parse(readFileSync("artifacts/distributed-faults/pitr-inventory.json", "utf8"));
if (inventory.status !== "PASS" || inventory.streamedExternalObjects < 1)
  throw Error("PITR did not recover and verify a published external object");
const result = { drill: "postgres16_archived_wal_pitr", status: "PASS",
  recoveryTargetLSN: target, includedBeforeTarget: true, excludedAfterTarget: true,
  fullSourceObjectInventory: true, verifiedObjectCount: inventory.inspectedObjects,
  verifiedSnapshotNodes: inventory.verifiedSnapshotNodes,
  verifiedExternalBytes: inventory.verifiedRawBytes,
  elapsedSeconds: Number(elapsed),
  limitations: ["Isolated archived-WAL recovery, not provider-managed PITR",
    "Retained local S3 contents were independently verified, but not versioned-object rollback",
    "Not production RPO/RTO or multi-region restoration"] };
writeFileSync("artifacts/distributed-faults/postgresql-pitr.json", JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
NODE

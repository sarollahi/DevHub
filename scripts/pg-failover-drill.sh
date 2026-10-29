#!/usr/bin/env bash
set -Eeuo pipefail
# Isolated physical PostgreSQL streaming standby promotion. Never operate on
# production credentials or an existing PostgreSQL cluster.
[[ "${DEVHUB_FAULT_DRILL:-}" == "isolated-local-only" && "${NODE_ENV:-}" != "production" ]] ||
  { echo "Failover drill requires an isolated deployment" >&2; exit 2; }
mkdir -p artifacts/distributed-faults
network="devhub-failover-net-$$"
primary="devhub-failover-p-$$"
standby="devhub-failover-s-$$"
volume="devhub-failover-data-$$"
started="$(date +%s)"
cleanup() {
  docker rm -f "$primary" "$standby" >/dev/null 2>&1 || true
  docker volume rm -f "$volume" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
docker network create "$network" >/dev/null
docker volume create "$volume" >/dev/null
docker run -d --rm --name "$primary" --network "$network" --network-alias pg-primary \
  -e POSTGRES_USER=devhub -e POSTGRES_DB=devhub -e POSTGRES_PASSWORD=devhub \
  postgres:16-alpine -c wal_level=replica -c max_wal_senders=10 -c max_replication_slots=10 >/dev/null
for i in $(seq 1 45); do
  if docker exec "$primary" pg_isready -U devhub -d devhub >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$primary" pg_isready -U devhub -d devhub >/dev/null
docker exec "$primary" psql -U devhub -d devhub -v ON_ERROR_STOP=1 \
  -c "CREATE ROLE replica WITH LOGIN REPLICATION PASSWORD 'replica-ci-only';"
docker exec "$primary" sh -c \
  "echo 'host replication replica 0.0.0.0/0 scram-sha-256' >> /var/lib/postgresql/data/pg_hba.conf"
docker exec "$primary" psql -U devhub -d devhub -c "SELECT pg_reload_conf()" >/dev/null
docker run --rm --network "$network" --user root -v "$volume":/var/lib/postgresql/data \
  postgres:16-alpine sh -c 'chown -R postgres:postgres /var/lib/postgresql/data'
docker run --rm --network "$network" --user postgres -v "$volume":/var/lib/postgresql/data \
  -e PGPASSWORD=replica-ci-only postgres:16-alpine \
  pg_basebackup -h pg-primary -U replica -D /var/lib/postgresql/data -Fp -Xs -R -P >/dev/null
# Add the application_name used for synchronous_commit=remote_apply.
docker run --rm --network "$network" --user postgres -v "$volume":/var/lib/postgresql/data \
  postgres:16-alpine sh -c \
  "echo \"primary_conninfo = 'host=pg-primary port=5432 user=replica password=replica-ci-only application_name=standby1'\" >> /var/lib/postgresql/data/postgresql.auto.conf"
docker run -d --rm --name "$standby" --network "$network" --network-alias pg-standby \
  -v "$volume":/var/lib/postgresql/data postgres:16-alpine >/dev/null
for i in $(seq 1 60); do
  state="$(docker exec "$primary" psql -U devhub -d devhub -Atc \
    "SELECT COUNT(*) FROM pg_stat_replication WHERE application_name='standby1' AND state='streaming'" 2>/dev/null || echo 0)"
  if [[ "$state" == 1 ]]; then break; fi
  sleep 1
done
[[ "$state" == 1 ]] || { echo "Physical standby never joined streaming state" >&2; exit 1; }
# Acknowledged sentinel cannot be lost under synchronous apply. This is
# meaningful physical-replication evidence, unlike restarting one container.
docker exec "$primary" psql -U devhub -d devhub -v ON_ERROR_STOP=1 \
  -c "ALTER SYSTEM SET synchronous_standby_names = 'standby1';" >/dev/null
docker exec "$primary" psql -U devhub -d devhub -c "SELECT pg_reload_conf()" >/dev/null
docker exec "$primary" psql -U devhub -d devhub -v ON_ERROR_STOP=1 \
  -c "CREATE TABLE public.failover_sentinel (id integer PRIMARY KEY, payload text NOT NULL);" \
  -c "INSERT INTO public.failover_sentinel VALUES (1, 'durable-before-promotion');" >/dev/null
before="$(docker exec "$primary" psql -U devhub -d devhub -Atc \
  "SELECT pg_current_wal_lsn()")"
standby_seen="$(docker exec "$standby" psql -U devhub -d devhub -Atc \
  "SELECT payload FROM public.failover_sentinel WHERE id=1")"
[[ "$standby_seen" == "durable-before-promotion" ]] || { echo "Replica did not apply acknowledged sentinel"; exit 1; }
# HARD FENCE: the old writer is physically stopped before promotion.
docker stop "$primary" >/dev/null
[[ "$(docker inspect -f '{{.State.Running}}' "$primary")" == "false" ]] ||
  { echo "Old primary was not fenced" >&2; exit 1; }
docker exec "$standby" sh -c 'pg_ctl -D /var/lib/postgresql/data promote' >/dev/null
for i in $(seq 1 30); do
  recovering="$(docker exec "$standby" psql -U devhub -d devhub -Atc \
    'SELECT pg_is_in_recovery()' 2>/dev/null || echo t)"
  if [[ "$recovering" == "f" ]]; then break; fi
  sleep 1
done
[[ "$recovering" == "f" ]] || { echo "Standby not promoted"; exit 1; }
after="$(docker exec "$standby" psql -U devhub -d devhub -Atc \
  'SELECT payload FROM public.failover_sentinel WHERE id=1')"
[[ "$after" == "$standby_seen" ]] || { echo "Acknowledged transaction lost after promotion"; exit 1; }
docker exec "$standby" psql -U devhub -d devhub -v ON_ERROR_STOP=1 \
  -c "INSERT INTO public.failover_sentinel VALUES (2, 'writes-resumed');" >/dev/null
after_count="$(docker exec "$standby" psql -U devhub -d devhub -Atc \
  'SELECT COUNT(*) FROM public.failover_sentinel')"
[[ "$after_count" == 2 ]] || { echo "Promoted standby is not writable"; exit 1; }
node --input-type=module - "$before" "$(( $(date +%s) - started ))" <<'NODE'
import { writeFileSync } from "node:fs";
const [, , primaryLSN, elapsedSeconds] = process.argv;
const evidence = { drill: "pg16_physical_replica_fenced_promotion", status: "PASS",
  oldPrimaryStoppedBeforePromotion: true, standbyStreamingBeforeFault: true,
  synchronousCommitMode: "remote_apply", lastPrimaryLSN: primaryLSN,
  acknowledgedSentinelSurvived: true, promotedWritable: true,
  elapsedSeconds: Number(elapsedSeconds),
  limitation: "Isolated local primary/standby; not cloud-managed failover or multi-region RTO" };
writeFileSync("artifacts/distributed-faults/postgresql-failover.json", JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
NODE

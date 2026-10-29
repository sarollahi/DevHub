#!/usr/bin/env bash
set -Eeuo pipefail
# Disruptive AWS Aurora *staging* exercise. Run only in the protected manual
# certification environment, after backups and an operator-approved window.
[[ "${DEVHUB_CERT_STAGE:-}" == "protected-staging" &&
   "${DEVHUB_CERT_CONFIRM:-}" == "PERFORM_STAGING_FAILOVER" ]] ||
  { echo "Not approved for disruptive managed failover" >&2; exit 2; }
cluster="${CERT_AURORA_CLUSTER_ID:-}"
[[ "$cluster" =~ ^devhub-cert-[a-z0-9-]{4,70}$ ]] ||
  { echo "Only a dedicated devhub-cert-* staging cluster is allowed" >&2; exit 2; }
[[ -n "${DATABASE_URL:-}" && "${DATABASE_URL}" == *"$cluster"* ]] ||
  { echo "Staging DSN must explicitly identify selected cluster" >&2; exit 2; }
command -v aws >/dev/null
command -v psql >/dev/null
mkdir -p artifacts/managed-certification
run="$(date -u +%Y%m%dT%H%M%SZ)-$$"
safe_run="${run//[^a-zA-Z0-9]/}"
export PGCONNECT_TIMEOUT=3
describe() { aws rds describe-db-clusters --db-cluster-identifier "$cluster" --output json; }
writer() {
  describe | node -e 'let b="";process.stdin.on("data",x=>b+=x).on("end",()=>{const c=JSON.parse(b).DBClusters?.[0];const w=c?.DBClusterMembers?.filter(x=>x.IsClusterWriter)||[];if(w.length!==1)process.exit(2);console.log(w[0].DBInstanceIdentifier);})'
}
before="$(writer)"
[[ -n "$before" ]] || { echo "No single writer"; exit 1; }
is_writer="$(psql "$DATABASE_URL" -AtX -c 'SELECT NOT pg_is_in_recovery()')"
[[ "$is_writer" == t ]] || { echo "DB endpoint not pointing to writer"; exit 1; }
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -c \
  'CREATE TABLE IF NOT EXISTS public.devhub_managed_failover_proof (
  run_id text NOT NULL, sequence integer NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(run_id,sequence))' >/dev/null
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -c \
  "INSERT INTO public.devhub_managed_failover_proof(run_id,sequence) VALUES ('$safe_run',1) ON CONFLICT DO NOTHING" >/dev/null
start_ms="$(date +%s%3N)"
aws rds failover-db-cluster --db-cluster-identifier "$cluster" >/dev/null
changed=""
for i in $(seq 1 180); do
  after="$(writer 2>/dev/null || true)"
  if [[ -n "$after" && "$after" != "$before" ]]; then
    if [[ "$(psql "$DATABASE_URL" -AtX -c 'SELECT NOT pg_is_in_recovery()' 2>/dev/null || true)" == t ]]; then
      changed="$after";break
    fi
  fi
  sleep 2
done
[[ -n "$changed" ]] || { echo "Managed endpoint did not resume on new writer in deadline"; exit 1; }
recovered_ms="$(( $(date +%s%3N) - start_ms ))"
count="$(psql "$DATABASE_URL" -AtX -c \
  "SELECT COUNT(*) FROM public.devhub_managed_failover_proof WHERE run_id='$safe_run' AND sequence=1")"
[[ "$count" == 1 ]] || { echo "Previously acknowledged transaction lost after failover"; exit 1; }
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -c \
  "INSERT INTO public.devhub_managed_failover_proof(run_id,sequence) VALUES ('$safe_run',2) ON CONFLICT DO NOTHING" >/dev/null
[[ "$(psql "$DATABASE_URL" -AtX -c \
  "SELECT COUNT(*) FROM public.devhub_managed_failover_proof WHERE run_id='$safe_run'")" == 2 ]] ||
  { echo "New writer did not persist idempotent write"; exit 1; }
node --input-type=module - "$cluster" "$before" "$changed" "$recovered_ms" <<'NODE'
import { writeFileSync } from "node:fs";
const [, , cluster, previousWriter, nextWriter, observedMs] = process.argv;
const record = { kind:"staging_managed_aurora_failover",status:"PASS",
  cluster, previousWriter, nextWriter, recoveredMs:Number(observedMs),
  previouslyAcknowledgedWriteSurvived:true,newIdempotentWriteCommitted:true,
  limitation:"This tests AWS-managed writer failover, not independent network fencing, broad write load, or multi-region RPO" };
writeFileSync("artifacts/managed-certification/aurora-failover.json", JSON.stringify(record,null,2));
console.log(JSON.stringify(record,null,2));
NODE

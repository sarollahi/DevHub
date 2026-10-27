# Integration performance and security verification

## Benchmarks

Use `npm run bench:integration -- --count=12000 --workers=16 --paths=80` for deterministic immutable merge-tree preparation. The JSON report includes workload size, wall time, throughput, latency p50/p95/p99, process peak RSS and correctness failures. This is a **synthetic in-process CPU workload**, not end-to-end throughput or simultaneous ref publication. There is no unsupported claim of thousands of successful production merges per second. Run `npm run bench:integration:db` on a **disposable, production-like PostgreSQL instance** for measured concurrent immutable changeset publication, durable integration admission and competing ref CAS outcomes. It creates a benchmark repository and writes fixture rows; never run it on live production. It records actual DB operation throughput and p50/p95/p99 request latency. Existing integration tests also exercise retry and reconciliation against newer revisions. Admission throughput must not be conflated with complete merge-throughput. Run a dedicated production-like load test before declaring an SLO.

## Threat model and review checklist

| Threat | Safeguard | Residual risk |
|---|---|---|
| Forged or stale CI results | Immutable revision, target snapshot, dependency and recipe hashes, signed runner tasks, required security/secrets checks | Runner key compromise; revoke credentials and rotate keys |
| Repository-wide merge lock or lost update | Independent immutable preparation, final per-reference generation + digest CAS, bounded retries | High contention can cause retries/starvation; monitor queue age |
| AI-derived privilege escalation | Machine actors cannot approve; original and candidate changesets need human approvals under protected/high-risk policies | Human reviewer collusion or compromised session |
| Direct update bypass | Existing protected UPDATE, RESTORE and CREATE routes blocked; signed bootstrap endpoint required | Imported/staged references and existing authorization grants require operational review |
| Dynamic deployment endpoint injection | Only server-configured allowlisted HTTPS controllers, strict host/IP validation, pinned DNS lookup and TLS validation; never accept a URL from the contributor | Controller compromise, network infrastructure compromise, false signed receipts |
| Forged deployment completion | HMAC-authenticated receipt linked to deployment UUID, revision and environment; final status is not set on bare HTTP 202 | Shared-key compromise; receiver must enforce idempotency and protect the deployment target |
| Stale deployment | Check latest exact source revision and signed predeployment gates immediately before dispatch; signed receipts checked against current ref | A ref can move after dispatch; controller must enforce revision fencing before side effects, and reconciliation may be needed |
| Worker process crash | Durable database state, leases, reprocessing with immutable IDs; idempotent commands | A remote controller without idempotency could duplicate side effects. It must implement command deduplication. |
| Local S3/tenant leakage | Repository authorization on source reads, immutable object checks, path guard | Independent tenancy penetration test remains necessary |
| Unknown binary, renamed, or overlapping edits | Conservative conflict state; auto line merge only for bounded UTF-8, disjoint line edits; no model-generated merge authorization | Semantic conflicts across separate files cannot be inferred reliably |

### Deployment controller contract

Configure `DEPLOYMENT_CONTROLLERS_JSON` on the trusted deployment worker, for example:

```json
{"production":{"url":"https://deploy.example.com/apply","secretEnv":"DEPLOYMENT_PRODUCTION_KEY","repositories":["REPOSITORY_UUID"]}}
```

Set `DEPLOYMENT_PRODUCTION_KEY` to a unique secret at least 32 characters long. The worker POSTs a signed immutable JSON deployment command (`x-devhub-signature`) to the **configured** HTTPS endpoint, with a stable deployment UUID as idempotency key. The controller must verify the request signature, confirm the repository and immutable revision with its own policy, deduplicate the command, and respond with HMAC-signed JSON (`x-devhub-receipt-signature`) containing deploymentId, revisionId, environment, receiptId and state. Only a signed `SUCCEEDED` state marks success; signed `ACCEPTED` remains pending. Later signed callbacks use `POST /api/v2/deployments/:deploymentId/receipt`.

Run `npm run worker:deployment` independently of web and source-control workers. Use production outbound firewall rules in addition to the built-in public IP validation. Failures and stale ref states must alert operators; a successful command acknowledgment is **not** a verified deployment.

### Remaining release gates

This review is a documented threat-model pass and automated regression suite, not an independent penetration test. Production release still requires independent security review, controller integration tests against a real managed environment, and load measurement on production-like PostgreSQL, object storage, and runner capacity. Do not market the in-process microbenchmark as an end-to-end SLO.

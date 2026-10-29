# Repository-wide related-change review

Native source changesets remain authoritative. Similarity findings are advisory and cannot authorize a merge.

## Durable indexing

Review workers verify source objects and read only touched paths from immutable snapshot trees, rather than materializing entire repositories. The review-completion transaction atomically publishes exact change fingerprints, equivalent-operation fingerprints, content keys, path keys, issue/subsystem keys, changed-line intervals and optional locality-sensitive vector signals. Every inverted-index query is scoped to a repository.

Exact identity includes parent revisions. Equivalent operation effect identity excludes parent IDs but includes before/after objects and operation kinds. Reused content in another file is a discovery hint, not automatically a duplicate. Line overlap is conservatively treated as a conflict for differing base objects; independent line intervals on the same base remain file-related but not conflicting. Approximate nearest neighbors and issue/subsystem matches remain advisory.

Candidate preview budgets apply separately by signal type, never by recency. A 100,000-revision history cannot cause a recent-candidate cutoff to hide exact identity from its own index. Popular path and subsystem matches may exceed preview budgets; review records explicitly flag that fact and the authorized, repository-scoped related-change endpoint provides cursor pagination. No similar change is silently discarded or auto-approved.

The target reconciler checks OPEN review requests against their current reference and queues fresh analysis if a reference changes. It compares touched paths against the new target to flag deterministic conflict risk. Review approvals remain tied to the immutable changeset and protected-branch rules remain unchanged.

## Configuration and records

DEVHUB_EMBEDDING_ENDPOINT, DEVHUB_EMBEDDING_MODEL, DEVHUB_EMBEDDING_API_KEY, DEVHUB_EMBEDDING_MIN_SIMILARITY (default 0.50), and DEVHUB_EMBEDDING_PROVIDER configure the standalone provider-neutral embedding interface. An openai-compatible HTTPS adapter is supplied. DEVHUB_EMBEDDING_USD_PER_MILLION_TOKENS supplies optional pricing; zero means unknown, not free. Existing review model settings remain supported, and sending source excerpts to the analysis model requires opt-in.

Model-call rows record operation, model/provider, latency, cost, supported token totals, confidence where supplied, success and failure. Security-sensitive deterministic findings never take instruction from generated model output.

## Performance and correctness evidence (2026-10-29)

The benchmark pipeline runs **real PostgreSQL 16 + Prisma persistence**. It inserts 1,000, 10,000 and 100,000 native changeset metadata records with corresponding persisted review, inverted-signal and interval rows. It then invokes the production `discoverRelated` implementation, measuring actual query latencies and PostgreSQL table/index sizes. The source-control revisions in this query dataset are synthetic *metadata*: they are not full canonical published snapshots. A separate test creates actual content-addressed source changesets and processes them with the real native review worker.

The first successfully verified run is [GitHub Actions run 40834488175](https://github.com/sarollahi/DevHub/actions/runs/40834488175), with machine-readable per-size JSON artifacts.

| Rows | Signal rows | Query p50 (ms) | Query p95 (ms) | Query p99 (ms) | Signal table + indexes |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 6,008 | 7.70 | 9.34 | 30.45 | 4.03 MB |
| 10,000 | 60,008 | 6.99 | 8.03 | 25.88 | 40.37 MB |
| 100,000 | 600,008 | 4.88 | 7.13 | 25.86 | 400.72 MB |

Every size recovered all **5 of 5 deliberately labeled pairs**: distant exact duplicate, equivalent operation effect, overlapping changed-line conflict, independent same-file edit, and vector-bucket similarity. That is **100% recall only on these five constructed pairs**, not general semantic precision or recall.

The sustained full-pipeline run [40834820843](https://github.com/sarollahi/DevHub/actions/runs/40834820843) published and processed **1,000 actual content-addressed changesets**, all of which completed with durable index rows and zero failures at **4 concurrent workers**. The measured worker throughput was **88.73 changes/second**, worker p95 latency **48.45 ms**, and time from queued record creation to completed persistent index was **20.79 seconds at p95**. The worker backlog was deliberately accumulated before processing began; index freshness includes that queue delay. These are CI-host measurements, not regional deployment commitments.

### Reproduction and scope

- `npm run bench:related-review` — original deterministic in-memory comparison, retained as a microbenchmark only.
- `npm run bench:related-db -- --count=100000 --workers=0 --output=reports/review-db-100000.json` — PostgreSQL persistence, retrieval, latency and physical index size. Requires `DATABASE_URL` and applied migrations.
- `npm run bench:related-db -- --count=1000 --workers=1000 --concurrency=4` — the same DB evaluation plus genuine immutable publication and full review-worker processing/freshness measurements.
- `npm run bench:related-semantic -- --mode=lexical` — fixed human-authored engineering-intent labels and an explicitly non-neural lexical baseline.
- `npm run bench:related-semantic -- --mode=provider` — evaluate actual embeddings through the configured provider interface, measuring multi-probe candidate recall, thresholded precision, recall, F1, request cost and latency. Requires a configured live provider. `Related-review PostgreSQL and worker scale` can also be run manually with `semantic_provider=true` and repository secrets `DEVHUB_EMBEDDING_ENDPOINT`, `DEVHUB_EMBEDDING_API_KEY`, and variable `DEVHUB_EMBEDDING_MODEL`.

CI stores results under `related-review-postgres-1000`, `related-review-postgres-10000`, `related-review-postgres-100000` and, for opt-in live evaluation, `related-semantic-real-provider`. Measurements should not be compared between machines or deployments without controlling PostgreSQL settings and hardware.

### Limitations that remain explicit

1. The historical scale query dataset is real SQL with *synthetic content metadata*, not 100,000 concurrently executed full changeset-review jobs.
2. The fixed five-pair test is a regression gate for matching semantics, not an independently labeled representative corpus.
3. Local lexical results and deterministic vector fixtures do not establish an external embedding model's accuracy. The opt-in provider evaluation must actually run with the intended provider/model and its results be assessed before deployment approval.
4. Measured costs, latency and worker throughput from single-host CI cannot establish a regional production deployment SLO. Full-scale environment validation additionally requires workload realism, soak tests, network failures and representative source distributions.

Approximate LSH cannot guarantee nearest-neighbor completeness; explicit cursor pagination and advisory-only findings prevent silently treating approximate suggestions as correctness or authorization decisions.

## Version 2 semantic retrieval correction

The first labeled ONNX MiniLM evaluation identified a real retrieval defect: the former 0.82 cosine cutoff rejected all 13 labeled paraphrase pairs, and the original sparse random projection was biased because its projection sign reused the parity bit determining the sampled coordinate for even-dimensional vectors. The updated implementation uses independent sign bits, 8 bands of 10 projection bits with one-bit multi-probe, a versioned LSH namespace, and an operator-configurable advisory similarity threshold (default 0.50). The threshold is not a universal semantic-quality guarantee: calibrate it independently for a production provider and a representative held-out dataset. Previous embeddings are queued for reindexing on deployment.

## Actual model evaluation and regression gate

The first actual-model run used `fastembed==0.9.1` and `sentence-transformers/all-MiniLM-L6-v2` on 26 fixed, human-authored engineering-intent examples (13 labeled equivalent pairs plus 624 directed negative pairs). It exposed **0% recall at the prior 0.82 cutoff and 7.7% ANN candidate recall**. This was a genuine retrieval failure, not a passed synthetic benchmark. Evidence: [ONNX evaluation run 40835240668](https://github.com/sarollahi/DevHub/actions/runs/40835240668).

After correcting the correlated LSH projection sign, expanding indexed bands and lowering the **advisory** cosine threshold to 0.50, replaying the identical real 384-dimensional MiniLM output yielded **14 true positives, 2 false positives, and 12 false negatives** (87.5% precision, 53.8% recall, 76.9% ANN candidate recall) on this small corpus. The automated real-model CI job now fails if precision drops below 75%, recall below 50%, or ANN candidate recall below 70% on that exact pinned fixture; it never uses this gate to approve or reject changesets. It is a regression guard, not a production-quality guarantee.

Thresholds and model-specific performance must be assessed against larger, held-out repositories before deployment. High semantic recall remains a quality goal; 53.8% recall on these hard paraphrases is a known limitation, not success against a representative corpus. Similarity findings remain hints and never silently discard proposals.

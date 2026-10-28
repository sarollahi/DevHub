# Repository-wide related-change review

Native source changesets remain authoritative. Similarity findings are advisory and cannot authorize a merge.

## Durable indexing

Review workers verify source objects and read only touched paths from immutable snapshot trees, rather than materializing entire repositories. The review-completion transaction atomically publishes exact change fingerprints, equivalent-operation fingerprints, content keys, path keys, issue/subsystem keys, changed-line intervals and optional locality-sensitive vector signals. Every inverted-index query is scoped to a repository.

Exact identity includes parent revisions. Equivalent operation effect identity excludes parent IDs but includes before/after objects and operation kinds. Reused content in another file is a discovery hint, not automatically a duplicate. Line overlap is conservatively treated as a conflict for differing base objects; independent line intervals on the same base remain file-related but not conflicting. Approximate nearest neighbors and issue/subsystem matches remain advisory.

Candidate preview budgets apply separately by signal type, never by recency. A 100,000-revision history cannot cause a recent-candidate cutoff to hide exact identity from its own index. Popular path and subsystem matches may exceed preview budgets; review records explicitly flag that fact and the authorized, repository-scoped related-change endpoint provides cursor pagination. No similar change is silently discarded or auto-approved.

The target reconciler checks OPEN review requests against their current reference and queues fresh analysis if a reference changes. It compares touched paths against the new target to flag deterministic conflict risk. Review approvals remain tied to the immutable changeset and protected-branch rules remain unchanged.

## Configuration and records

DEVHUB_EMBEDDING_ENDPOINT, DEVHUB_EMBEDDING_MODEL, DEVHUB_EMBEDDING_API_KEY and DEVHUB_EMBEDDING_PROVIDER configure the standalone provider-neutral embedding interface. An openai-compatible HTTPS adapter is supplied. DEVHUB_EMBEDDING_USD_PER_MILLION_TOKENS supplies optional pricing; zero means unknown, not free. Existing review model settings remain supported, and sending source excerpts to the analysis model requires opt-in.

Model-call rows record operation, model/provider, latency, cost, supported token totals, confidence where supplied, success and failure. Security-sensitive deterministic findings never take instruction from generated model output.

## Benchmark methodology

Run npm run bench:related-review to exercise deterministic in-memory inverted-index datasets of 1,000, 10,000 and 100,000 proposed changes, including duplicates and equivalent changes separated by long histories. Reported latency, index size, throughput and fixture precision/recall are SYNTHETIC. Actual PostgreSQL p95, index freshness under live worker load, real queue throughput, provider costs and semantic-model precision require deployed database and service measurements and are deliberately left unclaimed. Approximate LSH does not guarantee exhaustive semantic recall; operational evaluation must measure it against a larger manually labeled corpus.

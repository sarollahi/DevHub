# Secure Git interoperability gateway

The native changeset DAG, SHA-256 blobs, reference generations, validation policies, and audit log remain authoritative. Git objects, packs, and refs exist **only in a disposable derived cache** under `GIT_INTEROP_ROOT`. Git is never a second source of truth. The gateway updates its derived refs from native refs before each advertisement, fetch, or push. The exporter persists deterministic native-changeset-to-Git-SHA mappings and can reconstruct a lost cache. Git push ingestion stores raw commit bytes to preserve incoming signatures and SHA-1 identity across cache loss.

## Run

Apply Prisma migrations and generate the client, then launch the separate Node process:

```sh
npm ci
npm run db:deploy && npm run db:generate
mkdir -p /var/lib/devhub/git-cache && chmod 700 /var/lib/devhub/git-cache
GIT_INTEROP_ROOT=/var/lib/devhub/git-cache \
GIT_INTEROP_HOST=127.0.0.1 \
GIT_INTEROP_PORT=9419 \
GIT_INTEROP_TLS_TERMINATED=1 \
npm run git:gateway
```

Terminate TLS at a **trusted** reverse proxy and forward `/git/` to this local port. Never expose the process publicly over plaintext HTTP; only configure `GIT_INTEROP_TLS_TERMINATED=1` when the upstream and proxy-to-gateway network are secured. For localhost testing only, `GIT_INTEROP_ALLOW_INSECURE_LOCALHOST=1` allows cleartext. Run **one gateway process per cache root**, with private filesystem permissions and Git installed. Multiple gateway replicas require distributed coordination and shared cache consistency before being enabled.

Create a human Git credential by sending a same-origin authenticated POST:

```json
POST /api/v2/repositories/REPOSITORY_UUID/git-credentials
{"scopes":["source:read","changeset:write","ref:update"],"days":7}
```

The response returns `token` **once**. Git credentials expire in 1–30 days; list them using GET of the same endpoint and revoke by DELETE `/api/v2/repositories/:id/git-credentials/:credentialId`. The token never inherits broader privileges than its user; repository/team/path/branch denies, token scopes and revocation are rechecked at native enforcement time. Do not store this token in a remote URL. Use a trusted OS credential manager or `GIT_ASKPASS` and supply any username with the token as the HTTPS password.

```sh
git clone https://git.devhub.example/git/REPOSITORY_UUID.git
git -C REPOSITORY_UUID fetch origin
git -C REPOSITORY_UUID push origin HEAD:refs/heads/topic-branch
```

If the native default branch has not been created, use `git clone -b EXISTING_BRANCH` and configure HEAD after protected bootstrap. The gateway supports Git smart HTTP v0/v1 upload-pack and receive-pack. Fetch and clone use standard Git object packs; the exporter writes SHA-1 Git blobs, trees, and commits derived from native SHA-256 objects. No full native repository clone is needed in the client.

## Push admission

`git-receive-pack` runs in a quarantine object directory. The synchronous server-installed pre-receive hook:
1. Demands exactly one ref update (heads or lightweight tags), rejects delete/force/non-fast-forward and unrecognized refs.
2. Verifies that the advertised old Git object matches the exact native reference generation and target.
3. Rechecks authenticated human token, organization membership, operation scopes, explicit DENY grants, and branch/path policies.
4. Validates each new commit's DAG, tree modes, symlinks, path count, referenced objects and Git hashes through the existing native importer. New blobs stream into the immutable S3-backed store, with SHA-1 and native SHA-256 verification.
5. Persists immutable native changesets, original Git identity mappings, and audit events. Then invokes the native reference CAS. **Only this CAS can admit a ref update.** Protected refs still require the validated integration pathway; the hook never invents an approval or execution result.

On CAS failure, Git refuses the ref update. Already imported immutable objects/changesets may be unreferenced and later handled by existing GC policy. On a Git ref write failure *after* successful native CAS, the native update remains authoritative; a subsequent gateway operation repairs the derived Git ref. Clients should fetch when a push has an ambiguous transport failure. There is no claim of atomicity across a Git cache ref update and the separate PostgreSQL CAS.

## Scope and limitations

- Requires standard Git SHA-1 repositories. Git SHA-256 object-format repositories, shallow/partial clones, Git protocol SSH, Git LFS storage endpoints, submodules/gitlinks and replace refs are not supported.
- Branch names and lightweight tags are exported. Annotated tags imported by the migration tool are projected as lightweight tags to their target commits; tag annotations/signatures are not round-tripped. Exported native-only changesets get deterministic synthetic Git committers plus a native identity trailer. The original Git SHA of previously imported history may change on projection when full raw Git objects were not retained by the importer; tree contents and ancestry are authoritative.
- Git **push** is fast-forward-only, single-ref-only, and capped at 2,000 new commits per request. Immutable tags cannot be moved or deleted. Pushing to protected or default refs is rejected unless future work integrates the full review/validation admission protocol with receive-pack.
- Native changeset limits (including per-revision file/path limits), path normalization and unsafe symlink restrictions are enforced. Unsupported Git trees are rejected rather than being silently corrupted.
- A Git client cannot publish Git-originated authorship as an authorization identity. Authorship is source metadata; only the authenticated Git credential owner authorizes mutations.
- Export is incremental: already materialized Git commit SHA mappings and Git blob cache identities are reused; each new changeset is projected by applying its file operations onto the first-parent Git index and preserving all ordered merge parents. Rebuilding the lost disposable cache necessarily re-reads native history and objects.
- The gateway currently serializes Git RPCs **per repository** to avoid a partially refreshed local object cache being served concurrently with receive-pack; native changeset integration does not use this lock. This deployment is a single-replica baseline, not a multi-node Git front end.
- A Git client may see transfer failure after native ref CAS if its socket drops; retry only after fetching and inspecting the native reference. No distributed dual-write transaction is claimed.

## Verification and performance

```sh
npm run typecheck
npm run test:integration
npm run bench:git-interop -- \\
  --url=https://git.devhub.example/git/REPOSITORY_UUID.git \\
  --native-server=https://devhub.example \\
  --native-repository=REPOSITORY_UUID \\
  --native-ref=main \\
  --native-file=README.md \\
  --native-cli=devhub
```

The integration test exercises actual smart HTTP clone/fetch/push with PostgreSQL and object storage, binary bytes, executable modes, symlinks, a protected branch rejection, stable SHA mapping, revoked credentials, interrupted push transport, and a stale native-vs-Git CAS race. The benchmark reports Git clone network/fetch work, Git checkout/materialization, and incremental fetch as separate timings. With native flags (and `DEVHUB_TOKEN` configured), it also times native `sync` and `hydrate` independently. Run on equivalent revisions and selected paths with cold and warm caches; full Git checkout and sparse native hydration have different workloads. Git's initial pack transfer is not equivalent to a sparse native client fetch.

Production rollout still requires TLS proxy hardening, threat modeling, load tests for concurrent tenants and large repositories, runner isolation for untrusted hooks beyond server-installed pre-receive, multi-node cache architecture, and full Git protocol-version compatibility testing.
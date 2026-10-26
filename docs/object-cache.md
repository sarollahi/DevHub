# Shared immutable-object caches

DevHub clients never need a full repository clone to request an object. An optional node-local daemon shares blob and tree bytes across local clients and CI jobs using HTTP/1.1 over an OS-local socket. A regional instance serves the same versioned API over authenticated TCP. Both caches are disposable and **never** publish changesets or refs.

```text
Developer / CI / agent -> node socket cache -> optional regional cache -> authoritative /api/v2/repositories/:repo/objects/:id?format=raw
```

An immutable object ID is SHA-256 over `BLOB` or `TREE`, a NUL separator, and the exact bytes. Every cache fetch and every local cache hit is checked against that ID before delivery. Authorization remains with the authoritative service: cache daemons are trusted within a configured service domain; they do not grant multi-tenant access by themselves. Repository IDs are included in the local cache key. Do **not** expose a local socket to untrusted users or share one cache across unrelated tenants. OS permissions (`0700` directory, `0600` socket) isolate a local daemon to its owner. An authenticated regional cache should run behind TLS and a network access policy; never expose plaintext bearer credentials on an untrusted network.

## Node cache

Node.js 22.18+ is required (no extra runtime dependencies). Start the authoritative DevHub API first, and use a service token allowed to read the selected repositories:

```bash
export DEVHUB_CACHE_DIR="$HOME/.cache/devhub/objects"
export DEVHUB_CACHE_SOCKET="$HOME/.cache/devhub/cache.sock"
export DEVHUB_ORIGIN_URL="https://devhub.example.com"
export DEVHUB_ORIGIN_TOKEN="<service-token>"
export DEVHUB_CACHE_REPOSITORIES="<repo-uuid-1>,<repo-uuid-2>"
export DEVHUB_CACHE_DISK_BYTES=536870912
export DEVHUB_CACHE_OBJECT_BYTES=16777216
node src/cache/daemon.mjs
```

Create the socket's parent directory before starting the daemon. For Windows, set `DEVHUB_CACHE_SOCKET` to a named pipe path such as `\\\\.\\pipe\\devhub-cache`. The local socket path is **not** a Git clone path. The daemon accepts `GET /v1/objects/:repositoryId/:objectId`, returns raw bytes, and sets `x-devhub-object-kind` and `x-devhub-object-id`. `GET /v1/status` returns counters and capacity state; no tokens or source bytes. Clients can use `getCachedObject` or `materializeCachedObject` from `src/cache/client.mjs`, which verify the digest again and publish materialized files only after verification. They request **only the IDs explicitly supplied** by sparse-workspace selection and do not traverse or download entire trees. The existing JSON endpoint remains available for clients that do not opt into the cache.

```js
import { getCachedObject, materializeCachedObject } from './src/cache/client.mjs';
const selected = await getCachedObject({ socketPath: process.env.DEVHUB_CACHE_SOCKET, repositoryId, id: treeOrBlobId });
await materializeCachedObject({ socketPath: process.env.DEVHUB_CACHE_SOCKET, repositoryId, id: selectedBlobId }, './workspace/file.bin');
```

## Optional regional cache

Run the same daemon using `DEVHUB_CACHE_PORT=8401` and `DEVHUB_CACHE_HOST=127.0.0.1` instead of `DEVHUB_CACHE_SOCKET`. Supply `DEVHUB_CACHE_ACCESS_TOKEN` (24+ characters), `DEVHUB_CACHE_DIR`, `DEVHUB_ORIGIN_URL`, and `DEVHUB_ORIGIN_TOKEN`. Put TLS termination in front of the regional service. Node caches use `DEVHUB_REGIONAL_URL=https://regional.example.com` and `DEVHUB_REGIONAL_TOKEN=<service-token>`. A regional miss fetches from authoritative storage; a node miss tries the regional layer once, falling back to origin only for a regional failure, not an authoritative `404`. Neither service can return unverified bytes.

## Operational behavior

- An in-process flight map coalesces simultaneous misses on an `(authorized repository, object ID)` key. Cold misses have a bounded transfer semaphore and waiting queue; excess requests return `503` with `Retry-After`, rather than creating unbounded queues.
- Separate circuit breakers for origin and region open after consecutive errors and back off exponentially with jitter. There are no automatic retry loops. Regional outages fall back directly to the origin under the same download capacity limit; origin failure is reported explicitly.
- Files stream into temporary paths with a fixed size ceiling, are hashed while transferring, and become visible only after a verified atomic rename. A metadata sidecar records the kind, length, repository, and object ID; file modification time persists LRU recency. Startup reconciles orphaned and incomplete files, and on-hit hash checks detect bit rot. Only one daemon may own a cache directory.
- The cache reserves worst-case bytes for in-flight downloads, caps the number of entries, and evicts least recently used entries that are not actively being read. Readers cannot obtain unverified bytes; a failed cache request does not modify source-control storage. Excess demand fails closed without wiping workspace changes.
- Use distinct service tokens per trust boundary and scope `DEVHUB_CACHE_REPOSITORIES` narrowly. Revoke cache tokens to revoke access to a trusted cache deployment; do not use this service as a public content CDN.

## Verification

```bash
npm test                 # Includes OS-process socket, coalescing, restart, corruption, and regional-failure tests
node scripts/benchmark-cache.mjs
```

The benchmark uses a controlled local HTTP origin with 12 ms simulated latency. It reports elapsed time and upstream call counts for cold startup, eight concurrent CI jobs, repeated warm checkouts, explicit misses and a sparse (10% file-selection) workspace. It is a repeatable **synthetic** baseline, not production throughput or a multi-gigabyte object benchmark. The current authoritative object API still materializes blobs in PostgreSQL; this cache does not fix its existing object-size limits and does not claim to implement large-object streaming in the authoritative store.

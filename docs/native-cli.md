# DevHub native CLI

The Rust executable is a **workspace client**, not a Git clone or a second source-of-truth. The server owns the DAG, object publication, ancestry, merges, history, and reviews. A local workspace stores sparse file metadata, materialized files, and a bounded disposable object cache.

## Installation

Rust stable (edition 2021) is required to build from source:

    cargo install --path client/devhub-cli

Cross-platform CI compiles release executables for Linux, macOS, and Windows and attaches them as workflow artifacts. Copy the executable to a directory on PATH. Do not install from untrusted artifacts.

## Authentication

Use a DevHub server agent credential with changesets:read and changesets:write scopes, or an administrator token. The repository is a DevHub UUID, not a GitHub owner/repo string.

    printf '%s' "$DEVHUB_TOKEN" | devhub auth login --server https://devhub.example --repository REPOSITORY_UUID --token-stdin
    devhub auth status
    devhub auth logout --server https://devhub.example

Set DEVHUB_TOKEN to bypass the on-disk token file for CI agents. The token file is private mode 0600 on Unix. On Windows, protect the OS user profile and prefer the environment variable or an external secret manager. Plain HTTP tokens are refused except for loopback development.

## Sparse developer workflow

    mkdir workspace && cd workspace
    devhub init --server https://devhub.example --repository REPOSITORY_UUID --ref main
    devhub select --dir src --file Cargo.toml
    devhub sync
    devhub hydrate src/main.rs Cargo.toml
    devhub status
    devhub sync --materialize
    devhub changeset create --message "Implement an API"
    devhub review submit --title "Implement an API" --target main

The default selection is **empty**. Nothing is cloned or hydrated without an explicit selection. sync reads only selected metadata. hydrate retrieves only requested file objects. sync --materialize retrieves the selected set after checking for local edits and collisions. The client never advances the remote branch when publishing a changeset.

An interrupted changeset is saved in .devhub/workspace.json with its idempotency key, expected object hashes, parent, and operations. Retry the same command without --message to resume. Use changeset abort-pending only to discard the local publication request (immutable blobs already uploaded remain server-side). If a tracked file changed during a pending publication, the client refuses to submit.

History and analysis run on the server:

    devhub history --limit 30
    devhub history --path src/main.rs
    devhub diff --from REVISION_A --to REVISION_B
    devhub blame src/main.rs
    devhub ancestry --left REVISION_A --right REVISION_B
    devhub merge --base COMMON_BASE --ours REVISION_A --theirs REVISION_B

merge is a **server-side three-way preview**, not a ref mutation. Conflicts are explicit. Blame is a bounded, first-parent stable-line algorithm, not a complete cross-merge line attribution engine.

## Protocol v2

HTTP JSON is versioned independently of Rust. All endpoints require bearer authentication and repository authorization.

| Endpoint | Purpose |
|---|---|
| GET /api/v1/repositories/:id/refs | Authoritative refs and generations |
| GET /api/v2/repositories/:id/changesets/:revision/tree?select=f:path&select=d:dir | Sparse revision metadata |
| GET /api/v2/repositories/:id/objects/:id/raw | Raw blob bytes; Range bytes=N-; strong ETag |
| POST /api/v2/repositories/:id/uploads | Start or resume, providing objectId and byteSize |
| PATCH /api/v2/repositories/:id/uploads/:objectId | Append up to 256 KiB using Upload-Offset |
| POST /api/v2/repositories/:id/changesets | Immutable publication and idempotency |
| GET /api/v2/repositories/:id/query/{history,diff,blame,ancestry,merge} | Server-side history and comparison |
| POST /api/v2/repositories/:id/reviews | Native changeset review request; does not move a ref |

SHA-256 blob identity is SHA256("BLOB\0" + binary bytes). Upload sessions persist offsets in PostgreSQL; retransmissions query the server before resuming. Clients verify downloaded content by hash before materialization.

## Operational limits

The existing canonical engine limits a single blob to **4 MiB**, a changeset to **200 operations**, a snapshot to **10,000 paths**, and first-parent reconstruction to **1,024 changesets**. The upload service honors these limits: it stores durable chunks but is **not** an unbounded multi-gigabyte streaming object store. The default cache budget is 64 MiB. Server-side queries are bounded to avoid resource exhaustion; current snapshot queries reconstruct state internally even when the HTTP payload is sparse. This is a correctness baseline, not a claim of large-history query performance.

Ref updates remain administrator-only and separate from immutable changeset publication. The native review API creates a durable review request but does not yet provide merge automation, CI gating, or a complete web review interface. The CLI refuses to destroy dirty local files, refuses path escapes, and reports network errors without treating them as success.

## Verification

    cargo test --manifest-path client/devhub-cli/Cargo.toml
    cargo build --release --manifest-path client/devhub-cli/Cargo.toml
    npm run test:integration
    npx tsx tests/native-client.e2e.ts

The last command requires DEVHUB_CLI to point to a compiled executable and a running DevHub server backed by PostgreSQL. CI runs real-server end-to-end checks, plus Linux/macOS/Windows Rust unit tests and builds.

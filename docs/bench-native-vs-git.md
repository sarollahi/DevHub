# Real native workspace versus Git checkout benchmark

The script \`scripts/bench-native-vs-git.mjs\` compares DevHub native sparse workspace synchronization against Git filtered clone/sparse checkout **using real endpoints**. It is separate from the synthetic blob-cache microbenchmark and does not invent throughput results.

## Prerequisites

Use a dedicated, disposable Linux VM or runner whose network interface is not carrying unrelated traffic. Make the same immutable content accessible through the native changeset ref and Git interoperability gateway. Provision a real DevHub credential and Git credential with only the required read permissions. Install Rust client (built binary), Git, GNU time (\`/usr/bin/time\`), and Node 22.

Copy \`scripts/native-vs-git.example.json\` outside the repository and replace the server, repository ID, Git URL, and selection prefixes with real values. Each scenario must have at most 128 selectors; use directory prefixes for large monorepos. The sample 1%, 10%, and 50% counts are illustrative **targets**, not measured or known repository sizes.

Configure the run:

    export DEVHUB_TOKEN='<native-read-only-token>'
    export DEVHUB_CLI='/absolute/path/to/devhub'
    export DEVHUB_BENCH_NET_DEVICE='eth0'
    # Optional local node cache:
    export DEVHUB_CACHE_SOCKET="$HOME/.cache/devhub/cache.sock"
    node scripts/bench-native-vs-git.mjs /path/to/benchmark.json > benchmark-results.json

Use a dedicated network interface. The recorded interface RX/TX byte deltas include *all* traffic on that interface; they are not valid per-process transfer metrics on shared hosts. Capture the Git gateway's server-side request and byte counters separately if the host cannot be isolated.

For each repetition the runner initializes a new native workspace, selects paths, performs a materialized synchronization, performs a Git filtered clone and sparse checkout, hashes every selected native and Git regular file, compares symlink targets, and rejects mismatched content or path counts. It then runs native and Git warm refreshes. Command timings include setup and checkout work. Each result records p50/p95/p99 wall latency, total network RX/TX bytes, CPU time, peak RSS, sample measurements, verified content bytes, and optional node-cache upstream request and hit metrics. Durations and network counters are captured only around the benchmark commands, not the content-verification pass.

The benchmark does **not** automatically deploy either service, generate a million-file fixture on the remote backend, or claim completed production-scale results. Publish benchmark results with hardware, network, repository identity, backend revision, cache state, object counts, and run date. A synthetic local pass cannot establish production parity.

## CI

The native workflow syntax-checks the benchmark runner. The cross-platform native smoke test and separate cache hierarchy benchmark remain correctness and synthetic load evidence, not a replacement for this production benchmark.

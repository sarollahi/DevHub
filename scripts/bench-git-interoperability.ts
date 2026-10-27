import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const args = process.argv.slice(2);
const option = (name: string) => args.find(x => x.startsWith("--" + name + "="))?.slice(name.length + 3) ??
  (args.indexOf("--" + name) >= 0 ? args[args.indexOf("--" + name) + 1] : undefined);
const values = (name: string) => args.filter(x => x.startsWith("--" + name + "=")).map(x => x.slice(name.length + 3));
function positive(name: string, fallback: number, max: number) {
  const value = Number(option(name) ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error("Invalid --" + name);
  return value;
}
const url = option("url");
if (!url) throw new Error("Provide --url=https://gateway.example/git/REPOSITORY_UUID.git");
const endpoint = new URL(url);
if (endpoint.username || endpoint.password ||
    (endpoint.protocol !== "https:" &&
      !(endpoint.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) &&
        process.env.GIT_INTEROP_ALLOW_INSECURE_LOCALHOST === "1"))) {
  throw new Error("The benchmark requires HTTPS without embedded credentials (HTTP loopback requires explicit opt-in)");
}
const iterations = positive("iterations", 10, 100);
const concurrency = positive("concurrency", 2, 16);
const warmup = Number(option("warmup") ?? 1);
if (!Number.isSafeInteger(warmup) || warmup < 0 || warmup > 20) throw new Error("Invalid --warmup");
const nativeServer = option("native-server");
const nativeRepository = option("native-repository");
const nativeFiles = values("native-file");
const nativeMode = !!nativeServer && !!nativeRepository && nativeFiles.length > 0;
if ((nativeServer || nativeRepository || nativeFiles.length) && !nativeMode) {
  throw new Error("Native comparison requires --native-server, --native-repository and --native-file");
}
if (nativeMode && !process.env.DEVHUB_TOKEN) throw new Error("DEVHUB_TOKEN is required for native CLI measurements");
const nativeExecutable = option("native-cli") || "devhub";
const nativeRef = option("native-ref") || "main";
const root = await mkdtemp(join(tmpdir(), "devhub-git-load-"));

async function command(binary: string, commandArgs: string[], cwd?: string) {
  return exec(binary, commandArgs, { cwd, timeout: 900000, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
}
async function measure(fn: () => Promise<unknown>) {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}
function statistics(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => Number(sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)].toFixed(2));
  return { count: sorted.length, minMs: at(0), p50Ms: at(0.50), p95Ms: at(0.95),
    p99Ms: at(0.99), maxMs: at(1), meanMs: Number((values.reduce((x, y) => x + y, 0) / values.length).toFixed(2)) };
}

type Measurement = Record<string, number>;
const measured: Measurement[] = [];
const failures: Array<{ iteration: number; message: string }> = [];
let revision: string | null = null;
const started = performance.now();
async function execute(index: number) {
  const folder = join(root, String(index));
  await mkdir(folder);
  const checkout = join(folder, "git");
  const output: Measurement = {};
  output.gitCloneFetch = await measure(() => command("git", ["clone", "--no-checkout", url, checkout]));
  if (!revision) revision = (await command("git", ["-C", checkout, "rev-parse", "HEAD"])).stdout.trim();
  output.gitCheckout = await measure(() => command("git", ["-C", checkout, "checkout", "-f"]));
  output.gitIncrementalFetch = await measure(() => command("git", ["-C", checkout, "fetch", "origin"]));
  if (nativeMode) {
    const nativeDir = join(folder, "native");
    await mkdir(nativeDir);
    await command(nativeExecutable,
      ["init", "--server", nativeServer!, "--repository", nativeRepository!, "--ref", nativeRef], nativeDir);
    for (const path of nativeFiles) await command(nativeExecutable, ["select", "--file", path], nativeDir);
    output.nativeMetadataSync = await measure(() => command(nativeExecutable, ["sync"], nativeDir));
    output.nativeMaterialize = await measure(() =>
      command(nativeExecutable, ["hydrate", ...nativeFiles], nativeDir));
  }
  if (index >= warmup) measured.push(output);
}

try {
  const total = iterations + warmup;
  // Fixed worker pool gives bounded fanout and repeatable, controlled load.
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, async () => {
    while (cursor < total) {
      const index = cursor++;
      try { await execute(index); }
      catch (error) {
        failures.push({ iteration: index, message: error instanceof Error ? error.message.slice(0, 2000) : String(error) });
      }
    }
  }));
  const keys = ["gitCloneFetch", "gitCheckout", "gitIncrementalFetch",
    ...(nativeMode ? ["nativeMetadataSync", "nativeMaterialize"] : [])];
  const metrics = Object.fromEntries(keys.map(key => [key, statistics(measured.map(x => x[key]))]));
  const failuresCount = failures.length;
  const report = { benchmark: "devhub-git-interoperability", generatedAt: new Date().toISOString(),
    repository: endpoint.origin + endpoint.pathname, revision, iterations, warmup, concurrency,
    workload: nativeMode ? { git: "full clone + full checkout", native: "selected sparse paths", paths: nativeFiles } :
      { git: "full clone + full checkout", native: "not requested" },
    elapsedMs: Number((performance.now() - started).toFixed(2)),
    metrics, failureCount: failuresCount, failures };
  const outputFile = option("output");
  if (outputFile) await writeFile(outputFile, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
  for (const key of keys) {
    const threshold = option("max-p95-" + key);
    if (threshold !== undefined &&
      (!Number.isFinite(Number(threshold)) || Number(threshold) <= 0 ||
        (metrics[key]?.p95Ms ?? Number.POSITIVE_INFINITY) > Number(threshold))) {
      throw new Error("p95 latency exceeded configured limit for " + key);
    }
  }
  if (failuresCount) throw new Error(failuresCount + " Git benchmark iterations failed");
} finally {
  await rm(root, { recursive: true, force: true });
}

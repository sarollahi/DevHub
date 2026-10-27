import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const url = process.argv.find(x => x.startsWith("--url="))?.slice(6) ||
  (process.argv[2] === "--url" ? process.argv[3] : undefined);
if (!url || !/^https?:\/\//.test(url)) throw new Error("Pass --url=https://trusted-gateway/git/UUID.git");
const root = await mkdtemp(join(tmpdir(), "devhub-git-benchmark-"));
async function measure(name: string, fn: () => Promise<unknown>) {
  const start = performance.now();
  await fn();
  return [name, Math.round(performance.now() - start)] as const;
}
try {
  const checkout = join(root, "checkout");
  // --no-checkout isolates network/pack processing from filesystem materialization.
  const timings = [];
  timings.push(await measure("gitCloneFetchMs", () => exec("git", ["clone", "--no-checkout", url, checkout])));
  timings.push(await measure("gitCheckoutMs", () => exec("git", ["-C", checkout, "checkout", "-f"])));
  timings.push(await measure("gitIncrementalFetchMs", () => exec("git", ["-C", checkout, "fetch", "origin"])));
  console.log(JSON.stringify({ benchmark: "git-interoperability", units: "ms",
    results: Object.fromEntries(timings), nativeClient: "measure separately with identical revision and selected paths" }));
} finally { await rm(root, { recursive: true, force: true }); }

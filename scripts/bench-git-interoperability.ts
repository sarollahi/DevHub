import { mkdtemp, mkdir, rm } from "node:fs/promises";
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
const url = option("url");
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
  const nativeServer = option("native-server");
  const nativeRepository = option("native-repository");
  const nativeFiles = values("native-file");
  if (nativeServer && nativeRepository && nativeFiles.length) {
    if (!process.env.DEVHUB_TOKEN) throw new Error("DEVHUB_TOKEN is required for the native benchmark");
    const nativeDir = join(root, "native-workspace");
    await mkdir(nativeDir);
    const executable = option("native-cli") || "devhub";
    const ref = option("native-ref") || "main";
    await exec(executable, ["init", "--server", nativeServer, "--repository", nativeRepository, "--ref", ref],
      { cwd: nativeDir });
    for (const file of nativeFiles) {
      await exec(executable, ["select", "--file", file], { cwd: nativeDir });
    }
    timings.push(await measure("nativeMetadataSyncMs", () =>
      exec(executable, ["sync"], { cwd: nativeDir })));
    timings.push(await measure("nativeMaterializeMs", () =>
      exec(executable, ["hydrate", ...nativeFiles], { cwd: nativeDir })));
  } else if (nativeServer || nativeRepository || nativeFiles.length) {
    throw new Error("Supply --native-server, --native-repository and one or more --native-file=...");
  }
  console.log(JSON.stringify({ benchmark: "git-interoperability", units: "ms",
    results: Object.fromEntries(timings),
    comparison: nativeServer ? "Git full repository fetch/checkout versus selected native sparse sync/hydration" :
      "Git-only metrics; provide native arguments to benchmark separately" }));
} finally { await rm(root, { recursive: true, force: true }); }

import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { writeFile } from "node:fs/promises";

// Explicitly local-only. The wrapper always attempts restoration in finally;
// an interrupted host still requires the documented manual recovery command.
if (process.env.DEVHUB_FAULT_DRILL !== "isolated-local-only" || process.env.NODE_ENV === "production")
  throw new Error("Set DEVHUB_FAULT_DRILL=isolated-local-only and use an isolated test deployment");
const options = new Map(process.argv.slice(2).filter(x => x.startsWith("--")).map(arg => {
  const [key, value] = arg.slice(2).split("="); return [key, value];
}));
const service = options.get("service") || "redis";
const seconds = Number(options.get("seconds") || 5);
if (!["redis", "db", "minio"].includes(service) || !Number.isFinite(seconds) || seconds < 1 || seconds > 120)
  throw new Error("Supported service: redis, db, minio; --seconds=1..120");
const exec = args => execFileSync("docker", ["compose", ...args], { encoding: "utf8", stdio: "pipe" });
const started = Date.now();
let stopped = false;
let fault = null;
try {
  exec(["stop", service]); stopped = true;
  await sleep(seconds * 1000);
  // A real outage occurred; no mock/stub dependency was used.
} catch (error) { fault = error instanceof Error ? error.message : "unknown"; process.exitCode = 1; }
finally {
  try { exec(["start", service]); stopped = false; }
  catch (error) { fault = "RESTORE_FAILED: " + (error instanceof Error ? error.message : "unknown"); process.exitCode = 1; }
}
if (!stopped) {
  try {
    exec(["up", "-d", "--wait", service]);
    execFileSync("npx", ["tsx", "scripts/reconcile.ts", "--sample=50"],
      { stdio: "inherit", timeout: 120000, env: process.env });
  } catch (error) { fault = "RECOVERY_CHECK_FAILED: " + (error instanceof Error ? error.message : "unknown"); process.exitCode = 1; }
}
const result = { kind: "isolated_service_outage", service, outageSecondsRequested: seconds,
  elapsedSeconds: (Date.now() - started) / 1000, restored: !stopped, error: fault,
  note: "A stopped service tests dependency loss; it does not simulate a multi-region network partition." };
console.log(JSON.stringify(result, null, 2));
if (options.get("output")) await writeFile(options.get("output"), JSON.stringify(result, null, 2));

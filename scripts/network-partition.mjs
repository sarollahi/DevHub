import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

if (process.env.DEVHUB_FAULT_DRILL !== "isolated-local-only" || process.env.NODE_ENV === "production")
  throw new Error("Network partition tests are permitted only in isolated CI deployments");

const args = new Map(process.argv.slice(2).filter(x => x.startsWith("--")).map(x => {
  const pos = x.indexOf("="); return [x.slice(2, pos), x.slice(pos + 1)];
}));
const service = args.get("service") ?? "db";
const seconds = Number(args.get("seconds") ?? 3);
const ports = { db: 5432, redis: 6379, minio: 9000 };
if (!(service in ports) || !Number.isFinite(seconds) || seconds < 1 || seconds > 30)
  throw new Error("Only db, redis or minio, seconds 1..30, are supported");
const docker = (...cmd) => execFileSync("docker", cmd, { encoding: "utf8", timeout: 45000 }).trim();
const container = docker("compose", "ps", "-q", service);
if (!/^[a-f0-9]{12,64}$/.test(container)) throw new Error("Expected a running Compose service");
const inspect = () => JSON.parse(docker("inspect", container))[0];
const initial = inspect();
const networks = Object.keys(initial.NetworkSettings.Networks);
if (networks.length !== 1 || !/^[a-z0-9_.-]+$/i.test(networks[0]))
  throw new Error("Fault drill requires exactly one isolated Compose network");
const network = networks[0];
const probe = () => {
  try {
    // Independent peer on the Compose network, not the Docker host's published ports.
    docker("run", "--rm", "--network", network, "busybox:1.36",
      "sh", "-c", "nc -z -w 2 " + service + " " + ports[service]);
    return true;
  } catch { return false; }
};
if (!initial.State.Running || !probe()) throw new Error("Service was unreachable before partition");
const start = performance.now();
let separated = false, unreachable = false, failure = null;
try {
  docker("network", "disconnect", "-f", network, container);
  separated = true;
  await sleep(seconds * 1000);
  unreachable = !probe();
  if (!unreachable) throw new Error("Network separation did not interrupt peer connectivity");
  if (!inspect().State.Running) throw new Error("Partition caused process termination");
} catch (error) {
  failure = error instanceof Error ? error.message : "Unknown fault-injection error";
} finally {
  if (separated) {
    try { docker("network", "connect", "--alias", service, network, container); }
    catch (error) { failure = "RESTORATION_FAILED: " + String(error); }
  }
}
let restored = false;
for (let i = 0; i < 10; i++) {
  if (probe()) { restored = true; break; }
  await sleep(1000);
}
const final = inspect();
const result = {
  fault: "docker_network_disconnect", service, isolatedNetwork: network,
  outageSeconds: seconds, elapsedSeconds: Number(((performance.now() - start) / 1000).toFixed(3)),
  peerUnreachableDuringFault: unreachable, peerReachableAfterRestore: restored,
  originalProcessSurvived: final.State.Running && initial.State.Pid === final.State.Pid,
  error: failure,
};
if (args.get("output")) await writeFile(args.get("output"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
if (failure || !unreachable || !restored || !result.originalProcessSurvived) process.exitCode = 1;

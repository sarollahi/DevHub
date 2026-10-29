import { request } from "node:http";

export type ContainerUsage = {
  cpuNanos: bigint;
  sampledMemoryPeakBytes: bigint;
  networkRxBytes: bigint;
  networkTxBytes: bigint;
};

// Docker Engine stats are actual per-container cgroup counters. They are
// sampled while the disposable container exists; missing/unsupported stats
// remain null, never zero. This deliberately never invokes a shell.
const asCount = (value: unknown): bigint =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : 0n;
const max = (a: bigint, b: bigint) => a > b ? a : b;

export async function readContainerUsage(name: string): Promise<ContainerUsage | null> {
  if (!/^devhub-val-[a-f0-9]+-[a-f0-9]+$/.test(name)) return null;
  const dockerHost = process.env.VALIDATION_DOCKER_HOST || "unix:///var/run/docker.sock";
  if (!dockerHost.startsWith("unix://")) return null;
  const socketPath = dockerHost.slice("unix://".length);
  if (!socketPath.startsWith("/") || socketPath.includes("\0")) return null;
  return new Promise(resolve => {
    const req = request({
      socketPath, method: "GET",
      path: "/containers/" + name + "/stats?stream=false&one-shot=true",
      timeout: 1800, headers: { accept: "application/json" },
    }, res => {
      if (res.statusCode !== 200) { res.resume(); resolve(null); return; }
      const chunks: Buffer[] = [];
      let length = 0;
      res.on("data", (part: Buffer) => {
        length += part.length;
        if (length > 2 * 1024 * 1024) { req.destroy(); return; }
        chunks.push(part);
      });
      res.on("end", () => {
        try {
          const stats = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            cpu_stats?: { cpu_usage?: { total_usage?: number } };
            memory_stats?: { usage?: number; max_usage?: number };
            networks?: Record<string, { rx_bytes?: number; tx_bytes?: number }>;
          };
          if (stats.cpu_stats?.cpu_usage?.total_usage === undefined) {
            resolve(null); return;
          }
          let rx = 0n, tx = 0n;
          for (const n of Object.values(stats.networks || {})) {
            rx += asCount(n.rx_bytes); tx += asCount(n.tx_bytes);
          }
          resolve({
            cpuNanos: asCount(stats.cpu_stats.cpu_usage.total_usage),
            sampledMemoryPeakBytes: max(asCount(stats.memory_stats?.usage), asCount(stats.memory_stats?.max_usage)),
            networkRxBytes: rx, networkTxBytes: tx,
          });
        } catch { resolve(null); }
      });
    });
    req.once("timeout", () => req.destroy(new Error("Docker metrics timeout")));
    req.once("error", () => resolve(null));
    req.end();
  });
}
export function mergeContainerUsage(a: ContainerUsage | null, b: ContainerUsage | null) {
  if (!a) return b;
  if (!b) return a;
  return {
    cpuNanos: max(a.cpuNanos, b.cpuNanos),
    sampledMemoryPeakBytes: max(a.sampledMemoryPeakBytes, b.sampledMemoryPeakBytes),
    networkRxBytes: max(a.networkRxBytes, b.networkRxBytes),
    networkTxBytes: max(a.networkTxBytes, b.networkTxBytes),
  };
}

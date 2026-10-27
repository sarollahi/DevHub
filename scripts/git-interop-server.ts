import { createGitGateway } from "../src/source-control/git-gateway";
import { db } from "../src/lib/prisma";

if (!process.env.GIT_INTEROP_ROOT) throw new Error("GIT_INTEROP_ROOT must be configured");
const host = process.env.GIT_INTEROP_HOST || "127.0.0.1";
const port = Number(process.env.GIT_INTEROP_PORT || 9419);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid Git gateway port");
const server = createGitGateway();
server.listen(port, host, () => console.info(`DevHub Git gateway listening on ${host}:${port}`));
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => { void db.$disconnect().then(() => process.exit(0)); }));
}

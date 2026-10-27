import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { chmod, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { db } from "../lib/prisma";
import { assertRepositoryPermission, consumeRequestQuota } from "../lib/authorization";
import { SourceControlError, type SourceActor } from "./contracts";
import { gitCacheDirectory, gitCommand, syncGitProjection } from "./git-interoperability";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const transport = /^\/git\/([0-9a-f-]{36})\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;
const maxRequestBytes = Number(process.env.GIT_INTEROP_MAX_PUSH_BYTES || 2147483648);
const locks = new Map<string, Promise<void>>();

function exclusive<T>(id: string, work: () => Promise<T>): Promise<T> {
  const previous = locks.get(id) ?? Promise.resolve();
  const active = previous.catch(() => undefined).then(work);
  const tail = active.then(() => undefined, () => undefined);
  locks.set(id, tail);
  void tail.then(() => { if (locks.get(id) === tail) locks.delete(id); });
  return active;
}

function credentialFromRequest(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header || header.length > 4096) return null;
  const basic = /^Basic ([A-Za-z0-9+/=]+)$/.exec(header);
  if (basic) {
    const decoded = Buffer.from(basic[1], "base64").toString("utf8");
    const split = decoded.indexOf(":");
    if (split < 0) return null;
    return decoded.slice(split + 1);
  }
  const bearer = /^Bearer (dvg_[A-Za-z0-9_-]+)$/.exec(header);
  return bearer?.[1] ?? null;
}

async function authenticate(req: IncomingMessage, repositoryId: string, writing: boolean) {
  const token = credentialFromRequest(req);
  if (!token || !/^dvg_[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new SourceControlError(401, "GIT_AUTH_REQUIRED", "A short-lived Git credential is required");
  }
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const credential = await db.gitInteropCredential.findUnique({ where: { tokenHash } });
  if (!credential || credential.repositoryId !== repositoryId || credential.revokedAt ||
      credential.expiresAt <= new Date()) throw new SourceControlError(401, "GIT_CREDENTIAL_INVALID", "Git credential expired or revoked");
  const actor: SourceActor = { type: "HUMAN", id: credential.userId, gitCredentialId: credential.id };
  await assertRepositoryPermission(actor, repositoryId, writing ? "changeset:write" : "source:read",
    writing ? { allowStaging: true } : {});
  if (writing) await assertRepositoryPermission(actor, repositoryId, "ref:update");
  await consumeRequestQuota(repositoryId, actor);
  void db.gitInteropCredential.updateMany({ where: { id: credential.id, revokedAt: null },
    data: { lastUsedAt: new Date() } }).catch(() => undefined);
  return { actor, credentialId: credential.id };
}

function pktLine(text: string) {
  const contents = Buffer.from(text);
  return Buffer.concat([Buffer.from((contents.length + 4).toString(16).padStart(4, "0")), contents]);
}

function replyError(res: ServerResponse, error: unknown) {
  if (res.headersSent) { res.destroy(); return; }
  const status = error instanceof SourceControlError ? error.status : 503;
  const message = error instanceof Error ? error.message : "Git gateway unavailable";
  if (status === 401) res.setHeader("WWW-Authenticate", 'Basic realm="DevHub Git"');
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end(message.slice(0, 1000) + "\n");
}

async function installHooks(dir: string) {
  const projectRoot = resolve(import.meta.dirname, "../..");
  const tsx = resolve(projectRoot, "node_modules/.bin/tsx");
  const script = resolve(projectRoot, "scripts/git-interop-pre-receive.ts");
  // No shell expansion of client-provided data; generated absolute server paths only.
  const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
  const hook = "#!/bin/sh\nexec " + quote(tsx) + " " + quote(script) + "\n";
  await writeFile(resolve(dir, "hooks/pre-receive"), hook, { mode: 0o700 });
  await chmod(resolve(dir, "hooks/pre-receive"), 0o700);
  for (const [key, value] of [
    ["receive.fsckObjects", "true"], ["transfer.fsckObjects", "true"],
    ["receive.denyNonFastForwards", "true"], ["receive.denyDeletes", "true"],
    ["gc.auto", "0"],
  ]) await gitCommand(dir, ["config", "--local", key, value]);
}

async function serveGitRpc(req: IncomingMessage, res: ServerResponse, dir: string,
  service: "git-upload-pack" | "git-receive-pack", advertise: boolean,
  identity: { actor: SourceActor; credentialId: string }, repositoryId: string) {
  const max = service === "git-upload-pack" ? 4 * 1024 * 1024 : maxRequestBytes;
  const child = spawn("git", [service.replace(/^git-/, ""), "--stateless-rpc",
    ...(advertise ? ["--advertise-refs"] : []), dir], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_NO_REPLACE_OBJECTS: "1",
      GIT_TERMINAL_PROMPT: "0",
      DEVHUB_GIT_REPOSITORY_ID: repositoryId, DEVHUB_GIT_ACTOR_USER: identity.actor.id,
      DEVHUB_GIT_ACTOR_CREDENTIAL: identity.credentialId,
      DEVHUB_GIT_PUSH_GATE: service === "git-receive-pack" ? "enabled" : "disabled" },
  });
  let stderr = "", transferred = 0;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (data: string) => { stderr = (stderr + data).slice(-8192); });
  const deadline = setTimeout(() => child.kill("SIGKILL"), advertise ? 60000 : 900000);
  deadline.unref();
  try {
    if (advertise) {
      child.stdin.end();
      res.write(pktLine("# service=" + service + "\n"));
      res.write("0000");
    } else {
      req.on("data", (chunk: Buffer) => {
        transferred += chunk.length;
        if (transferred > max) {
          child.kill("SIGKILL");
          req.destroy(new Error("Git request limit exceeded"));
        }
      });
      req.pipe(child.stdin);
    }
    child.stdout.pipe(res, { end: false });
    const result = await new Promise<number>((yes, no) => {
      child.on("error", no);
      child.on("close", code => yes(code ?? -1));
      req.on("aborted", () => { child.kill("SIGKILL"); no(new Error("Client aborted Git request")); });
    });
    if (result !== 0) {
      console.error("Git RPC rejected", { repositoryId, service, result, error: stderr.slice(-1000) });
      if (!res.headersSent) throw new Error("Git RPC rejected: " + stderr.slice(-500));
    }
    res.end();
  } finally { clearTimeout(deadline); }
}

export function createGitGateway() {
  return createServer(async (req, res) => {
    try {
      if (req.url === "/healthz") {
        res.writeHead(200, { "Content-Type": "text/plain" }); res.end("ok\n"); return;
      }
      const parsed = new URL(req.url ?? "/", "http://localhost");
      const match = transport.exec(parsed.pathname);
      if (!match || !uuid.test(match[1])) {
        res.writeHead(404); res.end(); return;
      }
      const repositoryId = match[1];
      const isDiscovery = match[2] === "info/refs";
      const service = isDiscovery ? parsed.searchParams.get("service") : match[2];
      if ((req.method !== (isDiscovery ? "GET" : "POST")) ||
          (service !== "git-upload-pack" && service !== "git-receive-pack") ||
          (!isDiscovery && match[2] !== service)) {
        res.writeHead(405); res.end(); return;
      }
      const writing = service === "git-receive-pack";
      const encrypted = !!(req.socket as typeof req.socket & { encrypted?: boolean }).encrypted;
      const localhost = ["127.0.0.1", "::1"].includes(req.socket.remoteAddress ?? "");
      if (!encrypted && process.env.GIT_INTEROP_TLS_TERMINATED !== "1" &&
        !(localhost && process.env.GIT_INTEROP_ALLOW_INSECURE_LOCALHOST === "1")) {
        throw new SourceControlError(403, "TLS_REQUIRED", "Git authentication requires HTTPS");
      }
      const identity = await authenticate(req, repositoryId, writing);
      await exclusive(repositoryId, async () => {
        const dir = await gitCacheDirectory(repositoryId);
        await installHooks(dir);
        await syncGitProjection(repositoryId, identity.actor, dir);
        res.setHeader("Content-Type", `application/x-${service}-${isDiscovery ? "advertisement" : "result"}`);
        res.setHeader("Cache-Control", "no-cache, no-store, max-age=0");
        res.setHeader("Pragma", "no-cache");
        await serveGitRpc(req, res, dir, service, isDiscovery, identity, repositoryId);
      });
    } catch (error) {
      console.error("Git interoperability gateway", error);
      replyError(res, error);
    }
  });
}

import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const restrictedEnv = () => ({
  ...process.env,
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_NO_LAZY_FETCH: "1",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ALLOW_PROTOCOL: "file",
});

export async function allowedGitDirectory(source: string): Promise<string> {
  const root = process.env.GIT_IMPORT_ROOT;
  if (!root) throw new Error("GIT_IMPORT_ROOT is required; remote sources and arbitrary server paths are forbidden");
  const base = await realpath(root);
  const target = await realpath(isAbsolute(source) ? source : resolve(base, source));
  const subpath = relative(base, target);
  if (subpath === ".." || subpath.startsWith(".." + sep) || isAbsolute(subpath)) {
    throw new Error("Repository path is outside GIT_IMPORT_ROOT");
  }
  await gitText(target, ["rev-parse", "--git-dir"]);
  if ((await gitText(target, ["rev-parse", "--is-shallow-repository"])).trim() !== "false") {
    throw new Error("Shallow Git repositories cannot be migrated without their missing ancestors");
  }
  return target;
}

export function gitProcess(cwd: string, args: string[]) {
  const proc = spawn("git", ["-C", cwd, ...args], {
    env: restrictedEnv(), stdio: ["ignore", "pipe", "pipe"], shell: false,
  });
  let errorText = "";
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (chunk: string) => { errorText = (errorText + chunk).slice(-8192); });
  const exited = new Promise<void>((resolve, reject) => {
    proc.on("error", reject);
    proc.on("close", code => code === 0 ? resolve() :
      reject(new Error("git " + args[0] + " exited " + code + ": " + errorText)));
  });
  return { stdout: proc.stdout, exited, kill: () => proc.kill("SIGKILL") };
}

export async function gitText(cwd: string, args: string[], limit = 1024 * 1024): Promise<string> {
  const child = gitProcess(cwd, args);
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of child.stdout) {
      size += chunk.length;
      if (size > limit) throw new Error("Git metadata exceeds the allowed read limit");
      chunks.push(Buffer.from(chunk));
    }
    await child.exited;
    return Buffer.concat(chunks).toString("utf8");
  } catch (error) {
    child.kill();
    void child.exited.catch(() => undefined);
    throw error;
  }
}

export async function* gitDelimited(cwd: string, args: string[], separator: number, maxToken = 8192): AsyncGenerator<Buffer> {
  const child = gitProcess(cwd, args);
  let pending = Buffer.alloc(0);
  try {
    for await (const segment of child.stdout) {
      const chunk = Buffer.concat([pending, Buffer.from(segment)]);
      let start = 0;
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] !== separator) continue;
        if (i - start > maxToken) throw new Error("Git output contains an oversized path or record");
        yield chunk.subarray(start, i);
        start = i + 1;
      }
      pending = chunk.subarray(start);
      if (pending.length > maxToken) throw new Error("Git output record exceeds maximum size");
    }
    await child.exited;
    if (pending.length) throw new Error("Git output terminated with a partial record");
  } finally {
    child.kill();
    void child.exited.catch(() => undefined);
  }
}

export async function* gitLines(cwd: string, args: string[]): AsyncGenerator<string> {
  for await (const line of gitDelimited(cwd, args, 10, 4096)) {
    if (line.length) yield decodePath(line);
  }
}

export function decodePath(raw: Uint8Array): string {
  // Native paths are UTF-8. Reject rather than silently rename byte-oriented Git paths.
  return new TextDecoder("utf-8", { fatal: true }).decode(raw);
}

export type GitIdentity = { name: string; email: string; date: Date; timezone: string };
export type GitCommit = { sha: string; treeSha: string; parents: string[]; author: GitIdentity; committer: GitIdentity; message: string };
function parseIdentity(value: string): GitIdentity {
  const match = /^(.*) <([^<>]*)> (\d+) ([+-]\d{4})$/.exec(value);
  if (!match) throw new Error("Invalid Git commit identity");
  const timestamp = Number(match[3]);
  if (!Number.isSafeInteger(timestamp)) throw new Error("Invalid Git timestamp");
  return { name: match[1], email: match[2], date: new Date(timestamp * 1000), timezone: match[4] };
}

export async function readGitCommit(cwd: string, sha: string): Promise<GitCommit> {
  if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(sha)) throw new Error("Invalid Git commit SHA");
  const raw = await gitText(cwd, ["cat-file", "commit", sha], 1024 * 1024);
  const split = raw.indexOf("\n\n");
  if (split < 0) throw new Error("Git commit has no message delimiter");
  const header = raw.slice(0, split);
  const field = (key: string) => header.split("\n").find(line => line.startsWith(key + " "))?.slice(key.length + 1);
  const treeSha = field("tree");
  const author = field("author");
  const committer = field("committer");
  if (!treeSha || !author || !committer || !/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(treeSha)) throw new Error("Corrupt Git commit");
  return { sha, treeSha, parents: header.split("\n").filter(line => line.startsWith("parent ")).map(line => line.slice(7)),
    author: parseIdentity(author), committer: parseIdentity(committer), message: raw.slice(split + 2) };
}

export type GitDelta = { path: string; oldMode: string; newMode: string; oldSha: string; newSha: string; status: string };
export async function* gitDiff(cwd: string, sha: string, firstParent?: string): AsyncGenerator<GitDelta> {
  const args = firstParent ?
    ["diff-tree", "-r", "--raw", "--no-commit-id", "--no-renames", "-z", firstParent, sha] :
    ["diff-tree", "--root", "-r", "--raw", "--no-commit-id", "--no-renames", "-z", sha];
  const tokens = gitDelimited(cwd, args, 0, 8192)[Symbol.asyncIterator]();
  while (true) {
    const first = await tokens.next();
    if (first.done) return;
    const meta = decodePath(first.value);
    const match = /^:(\d{6}) (\d{6}) ([a-f0-9]{40,64}) ([a-f0-9]{40,64}) ([AMDT])$/.exec(meta);
    if (!match) throw new Error("Unsupported raw Git delta: " + meta.slice(0, 120));
    const second = await tokens.next();
    if (second.done) throw new Error("Truncated Git delta");
    const path = decodePath(second.value);
    yield { path, oldMode: match[1], newMode: match[2], oldSha: match[3], newSha: match[4], status: match[5] };
  }
}

export async function* gitTreeEntries(cwd: string, sha: string): AsyncGenerator<{ path: string; sha: string; mode: string }> {
  for await (const record of gitDelimited(cwd, ["ls-tree", "-r", "-z", "--full-tree", sha], 0, 8192)) {
    const tab = record.indexOf(9);
    if (tab === -1) throw new Error("Invalid Git tree entry");
    const head = decodePath(record.subarray(0, tab));
    const match = /^(\d{6}) blob ([a-f0-9]{40,64})$/.exec(head);
    if (!match) throw new Error("Git submodules or unsupported object types require explicit migration support");
    yield { mode: match[1], sha: match[2], path: decodePath(record.subarray(tab + 1)) };
  }
}

import { SourceControlError } from "./contracts";

const oid = /^[0-9a-f]{40}$/;
const gitPart = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
export type GitIndexUpdate = { path: string; mode?: string; sha?: string };

export function gitRefName(name: string, kind: "BRANCH" | "TAG" | "RELEASE") {
  if (!name || name.length > 200 || !gitPart.test(name) || name.includes("//") ||
      name.includes("..") || name.includes("@{") || name.startsWith("/") ||
      name.endsWith("/") || name.split("/").some(p => p.endsWith(".lock") || p.endsWith("."))) {
    throw new SourceControlError(422, "INVALID_GIT_REF", "Git cannot represent this native ref");
  }
  if (kind === "TAG") {
    if (!name.startsWith("tags/") || name.length < 6) throw new Error("Invalid native tag namespace");
    return "refs/tags/" + name.slice(5);
  }
  if (name.startsWith("tags/")) throw new Error("Branch in immutable tag namespace");
  return "refs/heads/" + name;
}
export function fromGitRef(ref: string): { name: string; kind: "BRANCH" | "TAG" } {
  const prefix = ref.startsWith("refs/heads/") ? "refs/heads/"
    : ref.startsWith("refs/tags/") ? "refs/tags/" : null;
  if (!prefix) throw new SourceControlError(403, "UNSUPPORTED_GIT_REF", "Only heads and lightweight tags are writable");
  const kind = prefix === "refs/tags/" ? "TAG" : "BRANCH";
  const name = (kind === "TAG" ? "tags/" : "") + ref.slice(prefix.length);
  if (gitRefName(name, kind) !== ref) throw new SourceControlError(422, "INVALID_GIT_REF", "Invalid Git reference");
  return { name, kind };
}

export function serializeIndexUpdates(entries: GitIndexUpdate[]) {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    if (!entry.path || entry.path.includes("\0") || entry.path.includes("\n") || entry.path.startsWith("/")) {
      throw new Error("Unsafe Git index path");
    }
    if (entry.mode) {
      if (!["100644", "100755", "120000"].includes(entry.mode) || !entry.sha || !oid.test(entry.sha)) {
        throw new Error("Invalid Git index update");
      }
      chunks.push(Buffer.from(`${entry.mode} ${entry.sha}\t${entry.path}\0`));
    } else {
      chunks.push(Buffer.from(`0 ${"0".repeat(40)}\t${entry.path}\0`));
    }
  }
  return Buffer.concat(chunks);
}

type Imported = { authorName: string; authorEmail: string; authorDate: Date; authorTimezone: string;
  committerName: string; committerEmail: string; committerDate: Date; committerTimezone: string };
type Fields = { treeSha: string; parents: string[]; changeId: string; message: string;
  authorId: string; date: Date; imported?: Imported };

function safeName(value: string) {
  // No user-controlled newline may turn an identity into extra commit headers.
  return value.replace(/[\r\n\0<>]/g, " ").trim().slice(0, 120) || "DevHub contributor";
}
function safeEmail(value: string) {
  return /^[^\s<>\r\n\0@]+@[^\s<>\r\n\0@]+$/.test(value) ? value.slice(0, 250) : "contributor@devhub.invalid";
}
function person(name: string, email: string, date: Date, zone: string) {
  if (Number.isNaN(date.getTime())) throw new Error("Invalid changeset date");
  const offset = /^[+-](?:0\d|1[0-4])(?:[0-5]\d)$/.test(zone) ? zone : "+0000";
  return `${safeName(name)} <${safeEmail(email)}> ${Math.floor(date.getTime() / 1000)} ${offset}`;
}

export function commitBytes(input: Fields) {
  if (!oid.test(input.treeSha) || input.parents.some(p => !oid.test(p)) ||
      !/^[0-9a-f]{64}$/.test(input.changeId) || input.message.includes("\0")) {
    throw new Error("Invalid Git commit material");
  }
  const original = input.imported;
  const fallback = /^GIT:(.+) <([^<>]+)>$/.exec(input.authorId);
  const aName = original?.authorName ?? fallback?.[1] ?? "DevHub contributor";
  const aEmail = original?.authorEmail ?? fallback?.[2] ?? "contributor@devhub.invalid";
  const cName = original?.committerName ?? "DevHub";
  const cEmail = original?.committerEmail ?? "source-control@devhub.invalid";
  const aDate = original?.authorDate ?? input.date;
  const cDate = original?.committerDate ?? input.date;
  const author = person(aName, aEmail, aDate, original?.authorTimezone ?? "+0000");
  const committer = person(cName, cEmail, cDate, original?.committerTimezone ?? "+0000");
  // Trailer makes projection identity unambiguous across native actors and revisions.
  const message = input.message.replace(/\n*$/, "") + "\n\nDevHub-Changeset: " + input.changeId + "\n";
  return Buffer.from([
    "tree " + input.treeSha,
    ...input.parents.map(parent => "parent " + parent),
    "author " + author,
    "committer " + committer,
    "",
    message,
  ].join("\n"), "utf8");
}

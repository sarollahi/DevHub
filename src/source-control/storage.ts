import { createHash } from "node:crypto";
import { validPath } from "../lib/review-logic";
import type { TreeEntry } from "./contracts";
import { SourceControlError } from "./contracts";

export function objectId(kind: "BLOB" | "TREE", content: Uint8Array): string {
  return createHash("sha256").update(kind).update("\0").update(content).digest("hex");
}

export function encodeTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (sorted.length > 10_000 || sorted.some((entry, i) => !validPath(entry.path)
    || !/^[a-f0-9]{64}$/.test(entry.objectId)
    || (entry.mode !== undefined && !["100644", "100755", "120000"].includes(entry.mode)) || (i > 0 && sorted[i - 1].path === entry.path))) {
    throw new SourceControlError(422, "INVALID_TREE", "Tree contains invalid or duplicate paths");
  }
  const bytes = Buffer.from(JSON.stringify(sorted), "utf8");
  if (bytes.byteLength > 4_000_000) throw new SourceControlError(413, "TREE_TOO_LARGE", "Tree manifest exceeds storage limit");
  return bytes;
}

export function decodeTree(data: Uint8Array, expectedId: string): TreeEntry[] {
  if (objectId("TREE", data) !== expectedId) throw new Error("Tree object digest mismatch");
  const raw: unknown = JSON.parse(Buffer.from(data).toString("utf8"));
  if (!Array.isArray(raw) || raw.some((e) => !e || typeof e !== "object"
    || typeof e.path !== "string" || typeof e.objectId !== "string")) {
    throw new Error("Corrupt tree manifest");
  }
  const entries = raw as TreeEntry[];
  if (!encodeTree(entries).equals(Buffer.from(data))) throw new Error("Noncanonical tree manifest");
  return entries;
}

export function decodeBlob(base64: string): Buffer {
  const bytes = Buffer.from(base64, "base64");
  if (bytes.byteLength > 256_000 || bytes.toString("base64") !== base64) {
    throw new SourceControlError(422, "INVALID_BLOB", "Blob must be canonical base64 and at most 256 KB");
  }
  return bytes;
}

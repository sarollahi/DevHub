import { createHash, randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { db } from "../src/lib/prisma";
import { encodeTree, objectId } from "../src/source-control/storage";
import { ancestors, mergeBases } from "../src/source-control/query";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const args = new Map(process.argv.slice(2).map(arg => {
  const [key, value] = arg.replace(/^--/, "").split("=");
  return [key, value];
}));
const depth = Math.min(100_000, Math.max(10, Number(args.get("depth") ?? 5_000)));
const width = Math.min(400, Math.max(2, Number(args.get("width") ?? 64)));
const layers = Math.min(200, Math.max(2, Number(args.get("layers") ?? 50)));
if (![depth, width, layers].every(Number.isSafeInteger)) throw new Error("Invalid benchmark dimensions");
const token = randomBytes(8).toString("hex");
const user = await db.user.create({ data: { handle: "benchmark-" + token, email: token + "@example.invalid" } });
const repo = await db.repository.create({ data: { ownerId: user.id, slug: "benchmark", name: "DAG benchmarks" } });
const treeBytes = encodeTree([]);
const treeId = objectId("TREE", treeBytes);
const commits: string[] = [];
const parentRows: { changesetId: string; parentId: string; position: number }[] = [];

async function insertGroup(ids: string[]) {
  for (let i = 0; i < ids.length; i += 500) {
    await db.sourceChangeset.createMany({ data: ids.slice(i, i + 500).map(id => ({
      id, repositoryId: repo.id, treeId, authorId: "BENCHMARK", message: "Synthetic ancestry benchmark vertex",
    })) });
  }
  commits.push(...ids);
}
async function insertEdges() {
  for (let i = 0; i < parentRows.length; i += 500) {
    await db.sourceChangesetParent.createMany({ data: parentRows.slice(i, i + 500) });
  }
}
const elapsed = async <T>(label: string, task: () => Promise<T>) => {
  const start = performance.now();
  const value = await task();
  const ms = performance.now() - start;
  console.log(JSON.stringify({ label, milliseconds: Number(ms.toFixed(2)) }));
  return value;
};

try {
  await db.sourceObject.createMany({ data: [{ id: treeId, kind: "TREE", data: treeBytes, byteSize: treeBytes.byteLength }],
    skipDuplicates: true });
  const root = hash(token + ":root");
  await insertGroup([root]);
  const deepIds = Array.from({ length: depth }, (_, i) => hash(token + ":deep:" + i));
  await elapsed("build deep DAG", async () => {
    await insertGroup(deepIds);
    deepIds.forEach((id, i) => parentRows.push({ changesetId: id, parentId: i ? deepIds[i - 1] : root, position: 0 }));
  });
  let previous = [root];
  const wideLayers: string[][] = [];
  await elapsed("build wide DAG", async () => {
    for (let layer = 0; layer < layers; layer++) {
      const current = Array.from({ length: width }, (_, i) => hash(token + ":wide:" + layer + ":" + i));
      await insertGroup(current);
      current.forEach((id, i) => {
        const parents = [...new Set([previous[i % previous.length], previous[(i + 1) % previous.length]])];
        parents.forEach((parentId, position) => parentRows.push({ changesetId: id, parentId, position }));
      });
      wideLayers.push(current);
      previous = current;
    }
    await insertEdges();
  });
  const deep = await elapsed("deep ancestry", () => ancestors(repo.id, deepIds.at(-1)!));
  if (deep.length !== depth + 1) throw new Error("Incorrect deep ancestry cardinality");
  const wide = await elapsed("wide ancestry", () => ancestors(repo.id, wideLayers.at(-1)![0]));
  if (!wide.includes(root)) throw new Error("Incorrect wide ancestry");
  const bases = await elapsed("wide DAG merge bases", () =>
    mergeBases(repo.id, wideLayers.at(-1)![0], wideLayers.at(-1)![width - 1]));
  console.log(JSON.stringify({ depth, width, layers, vertices: commits.length, edges: parentRows.length,
    deepCount: deep.length, wideCount: wide.length, baseCount: bases.length,
    note: "Times include PostgreSQL query, network transport, and JavaScript processing; repeat for stable measurements." }));
} finally {
  for (let i = 0; i < commits.length; i += 500) {
    await db.sourceChangesetParent.deleteMany({ where: { changesetId: { in: commits.slice(i, i + 500) } } });
  }
  for (let i = 0; i < commits.length; i += 500) {
    await db.sourceChangeset.deleteMany({ where: { id: { in: commits.slice(i, i + 500) } } });
  }
  await db.repository.delete({ where: { id: repo.id } });
  await db.user.delete({ where: { id: user.id } });
  await db.$disconnect();
}

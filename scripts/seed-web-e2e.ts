// Isolated browser-test fixture. Never invoked by production or regular seeding.
import { createHash } from "node:crypto";
import { db } from "../src/lib/prisma";
import { objectId } from "../src/source-control/storage";
import { SnapshotTree } from "../src/source-control/snapshot-tree";
import { applyHistoricalOperations } from "../src/source-control/snapshot-backfill";
import { enqueueSearchObjects, indexSearchBatch } from "../src/workers/search-indexer";

async function main() {
  if (process.env.WEB_E2E_FIXTURE !== "isolated-ci") throw Error("Browser fixture requires an explicit isolated test environment");
  const user = await db.user.findUniqueOrThrow({ where: { handle: "sarollahi" } });
  const repo = await db.repository.findUniqueOrThrow({ where: { ownerId_slug: { ownerId: user.id, slug: "DevHub" } } });
  const first = createHash("sha256").update("web-e2e-first-" + repo.id).digest("hex");
  const second = createHash("sha256").update("web-e2e-second-" + repo.id).digest("hex");
  const contents = [
    "export const greeting = 'Hello';\n",
    "export const greeting = 'Hello DevHub';\n" + Array.from({ length: 215 }, (_, i) => "export const value" + i + " = " + i + ";").join("\n") + "\n",
    "# Browser test repository\n",
    "internal-only fixture content\n",
  ];
  const hashes = contents.map(text => objectId("BLOB", Buffer.from(text)));
  for (let index = 0; index < contents.length; index++) {
    const data = Buffer.from(contents[index]);
    await db.sourceObject.upsert({ where: { id: hashes[index] },
      create: { id: hashes[index], kind: "BLOB", byteSize: BigInt(data.length), data },
      update: {} });
  }
  await db.sourceChangeset.upsert({ where: { id: first },
    create: { id: first, repositoryId: repo.id, authorId: user.id,
      message: "Add greeting source", operations: { create: [{
        path: "src/hello.ts", kind: "ADD", objectId: hashes[0], fileMode: "100644",
      }] } }, update: {} });
  await db.sourceChangeset.upsert({ where: { id: second },
    create: { id: second, repositoryId: repo.id, authorId: user.id,
      message: "Extend greeting and add documentation",
      parents: { create: [{ parentId: first, position: 0 }] },
      operations: { create: [
        { path: "src/hello.ts", kind: "MODIFY", objectId: hashes[1], fileMode: "100644", position: 0 },
        { path: "README.md", kind: "ADD", objectId: hashes[2], fileMode: "100644", position: 1 },
      ] } }, update: {} });
  // Browser fixtures bypass native publication, so publish their exact derived
  // immutable roots before any UI indexed read.
  await db.$transaction(async tx => {
    const tree = new SnapshotTree(tx);
    let root = await applyHistoricalOperations(tree, tree.empty(), [{
      kind: "ADD", path: "src/hello.ts", previousPath: null,
      objectId: hashes[0], fileMode: "100644",
    }]);
    await tree.persist(root);
    await tx.sourceSnapshotRoot.createMany({
      data: [{ repositoryId: repo.id, changesetId: first, rootId: root }], skipDuplicates: true,
    });
    root = await applyHistoricalOperations(tree, root, [
      { kind: "MODIFY", path: "src/hello.ts", previousPath: null,
        objectId: hashes[1], fileMode: "100644" },
      { kind: "ADD", path: "README.md", previousPath: null,
        objectId: hashes[2], fileMode: "100644" },
    ]);
    await tree.persist(root);
    await tx.sourceSnapshotRoot.createMany({
      data: [{ repositoryId: repo.id, changesetId: second, rootId: root }], skipDuplicates: true,
    });
  });
  await db.sourceReference.upsert({ where: { repositoryId_name: { repositoryId: repo.id, name: "main" } },
    create: { repositoryId: repo.id, name: "main", changesetId: second, kind: "BRANCH" },
    update: { changesetId: second } });
  await db.sourceReview.upsert({ where: { changesetId: second },
    create: { changesetId: second, repositoryId: repo.id, state: "COMPLETED",
      paths: ["src/hello.ts", "README.md"], riskTier: "LOW", riskScore: 12, groupKey: "browser-fixture",
      summary: "Fixture source revision", confidence: 1 }, update: {} });
  // The unpublished secret blob may be indexed but must never appear in this repository snapshot.
  await enqueueSearchObjects(hashes);
  await indexSearchBatch(20);
  console.log(JSON.stringify({ repositoryId: repo.id, base: first, head: second }));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => db.$disconnect());

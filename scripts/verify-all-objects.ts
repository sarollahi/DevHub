import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { db } from "../src/lib/prisma";
import { verifyBlob } from "../src/object-store/service";
import { objectId, decodeTree } from "../src/source-control/storage";

/**
 * Full inventory of every authoritative SourceObject. Unlike the sampled
 * reconciler, this must consume and verify every external object byte.
 * Run on a quiesced source/target pair or repeat after the write window.
 * A zero exit status is a verified snapshot, not future availability.
 */
const output = process.argv.find(arg => arg.startsWith("--output="))?.slice(9);
const pageSize = 64;
const started = Date.now();
const failures: Array<{ check: string; id?: string; message?: string }> = [];
let scanned = 0, inline = 0, external = 0, bytes = 0n;
const record = (check: string, id?: string, error?: unknown) => {
  if (failures.length < 100) failures.push({
    check, ...(id ? { id } : {}),
    ...(error ? { message: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200) } : {}),
  });
};

try {
  const integrity = await db.$queryRaw<Array<{ name: string; total: bigint }>>`
    SELECT 'missing_ref_tip' AS name, COUNT(*)::bigint AS total
    FROM "SourceReference" r LEFT JOIN "SourceChangeset" c ON c.id=r."changesetId"
    WHERE r."deletedAt" IS NULL AND (c.id IS NULL OR c."repositoryId"<>r."repositoryId")
    UNION ALL
    SELECT 'missing_operation_object', COUNT(*)::bigint
    FROM "SourceFileOperation" op LEFT JOIN "SourceObject" o ON o.id=op."objectId"
    WHERE op."objectId" IS NOT NULL AND o.id IS NULL
    UNION ALL
    SELECT 'missing_operation_grant', COUNT(*)::bigint
    FROM "SourceFileOperation" op JOIN "SourceChangeset" c ON c.id=op."changesetId"
    LEFT JOIN "SourceObjectGrant" g ON g."repositoryId"=c."repositoryId" AND g."objectId"=op."objectId"
    WHERE op."objectId" IS NOT NULL AND g."objectId" IS NULL
    UNION ALL
    SELECT 'missing_snapshot_root', COUNT(*)::bigint
    FROM "SourceSnapshotRoot" r LEFT JOIN "SourceSnapshotNode" n ON n.id=r."rootId"
    WHERE n.id IS NULL
    UNION ALL
    SELECT 'missing_external_record', COUNT(*)::bigint
    FROM "SourceObject" o LEFT JOIN "StoredBlob" b ON b.id=o."externalId"
    WHERE o."externalId" IS NOT NULL AND (b.id IS NULL OR b.state <> 'READY')`;
  for (const row of integrity) if (row.total > 0n) record(row.name, undefined, row.total.toString());

  let cursor: string | undefined;
  do {
    const rows = await db.sourceObject.findMany({
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take: pageSize, orderBy: { id: "asc" },
      select: { id: true, kind: true, data: true, byteSize: true, externalId: true },
    });
    if (!rows.length) break;
    for (const object of rows) {
      scanned++;
      try {
        if (object.data !== null) {
          inline++;
          bytes += BigInt(object.data.length);
          if (object.byteSize !== BigInt(object.data.length) ||
              objectId(object.kind, object.data) !== object.id)
            throw Error("Inline length or content digest mismatch");
          if (object.kind === "TREE") decodeTree(object.data, object.id);
          if (object.externalId) throw Error("Inline object has unexpected external identity");
        } else {
          external++;
          if (object.kind !== "BLOB" || object.externalId !== object.id)
            throw Error("Malformed external object identity");
          const blob = await db.storedBlob.findUnique({ where: { id: object.id } });
          if (!blob || blob.state !== "READY" || blob.rawBytes !== object.byteSize)
            throw Error("External object not READY or incorrect length");
          await verifyBlob(blob);
          bytes += blob.rawBytes;
        }
      } catch (error) { record("object_corrupt_or_missing", object.id, error); }
    }
    cursor = rows.at(-1)!.id;
    if (rows.length < pageSize) break;
  } while (true);
  let scannedSnapshotNodes = 0;
  let nodeCursor: string | undefined;
  do {
    const nodes = await db.sourceSnapshotNode.findMany({
      ...(nodeCursor ? { cursor: { id: nodeCursor }, skip: 1 } : {}),
      take: pageSize, orderBy: { id: "asc" }, select: { id: true, data: true },
    });
    if (!nodes.length) break;
    const childIds = new Set<string>();
    const valueIds = new Set<string>();
    for (const node of nodes) {
      scannedSnapshotNodes++;
      try {
        const bytes = Buffer.from(node.data);
        const digest = createHash("sha256").update("DEVHUB-SNAPSHOT-V1\0").update(bytes).digest("hex");
        if (digest !== node.id) throw Error("Snapshot node hash mismatch");
        const body = JSON.parse(bytes.toString("utf8")) as unknown;
        if (!Array.isArray(body) || body.length !== 3 || body[0] !== 1 ||
            JSON.stringify(body) !== bytes.toString("utf8")) throw Error("Non-canonical snapshot node");
        const value = body[1];
        if (value !== null) {
          if (!Array.isArray(value) || !/^[a-f0-9]{64}$/.test(String(value[0])) ||
              !["100644","100755","120000"].includes(String(value[1])))
            throw Error("Malformed snapshot value");
          valueIds.add(value[0] as string);
        }
        if (!Array.isArray(body[2]) || body[2].length > 16) throw Error("Invalid snapshot edges");
        let previous = "";
        for (const edge of body[2]) {
          if (!Array.isArray(edge) || edge.length !== 3 ||
              typeof edge[0] !== "string" || !/^[a-f0-9]+$/.test(edge[0]) ||
              edge[0] <= previous || !/^[a-f0-9]{64}$/.test(String(edge[1])) ||
              !Number.isSafeInteger(edge[2]) || edge[2] < 1)
            throw Error("Corrupt snapshot child edge");
          previous = edge[0];
          childIds.add(edge[1] as string);
        }
      } catch (error) { record("snapshot_node_corrupt", node.id, error); }
    }
    const [children, values] = await Promise.all([
      db.sourceSnapshotNode.findMany({ where: { id: { in: [...childIds] } }, select: { id: true } }),
      db.sourceObject.findMany({ where: { id: { in: [...valueIds] } }, select: { id: true } }),
    ]);
    const childSet = new Set(children.map(x => x.id));
    const valueSet = new Set(values.map(x => x.id));
    for (const id of childIds) if (!childSet.has(id)) record("missing_snapshot_child", id);
    for (const id of valueIds) if (!valueSet.has(id)) record("missing_snapshot_value", id);
    nodeCursor = nodes.at(-1)!.id;
    if (nodes.length < pageSize) break;
  } while (true);
  const result = {
    kind: "full_source_object_inventory", startedAt: new Date(started).toISOString(),
    completedAt: new Date().toISOString(), durationMs: Date.now() - started,
    inspectedObjects: scanned, inlineObjects: inline, streamedExternalObjects: external,
    verifiedRawBytes: bytes.toString(), verifiedSnapshotNodes: scannedSnapshotNodes,
    referentialChecks: integrity.map(v => ({ check: v.name, count: v.total.toString() })),
    failures, status: failures.length ? "FAILED" : "PASS",
    limitation: "Requires a stable backup/write barrier to assert a point-in-time inventory; checks every SourceObject and immutable snapshot node, not future object availability",
  };
  if (output) await writeFile(output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (failures.length) process.exitCode = 1;
} catch (error) {
  const result = { status: "ERROR", scanned, cause: error instanceof Error ? error.message : String(error) };
  console.error(JSON.stringify(result));
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}

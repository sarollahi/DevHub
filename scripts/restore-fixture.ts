import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { db } from "../src/lib/prisma";
import { uploadBlob } from "../src/object-store/service";
import { createCanonicalChangeset } from "../src/source-control/canonical";
import { mutateReference } from "../src/source-control/refs";

// CI only: create an actual 1 MiB external S3 object referenced by a native
// changeset and ref, so restore cannot pass by verifying an empty object store.
if (process.env.DEVHUB_FAULT_DRILL !== "isolated-local-only")
  throw Error("Fixture is restricted to isolated recovery drills");
try {
  const suffix = randomBytes(5).toString("hex");
  const user = await db.user.create({ data: { handle: "restore-" + suffix,
    email: "restore-" + suffix + "@example.test" } });
  const repo = await db.repository.create({ data: { ownerId: user.id,
    slug: "restore-" + suffix, name: "Restore isolation fixture",
    defaultBranch: "main", requireHumanApproval: false } });
  const session = await db.humanSession.create({ data: { userId: user.id,
    tokenHash: randomBytes(32).toString("hex"), expiresAt: new Date(Date.now() + 3_600_000) } });
  const actor = { type: "HUMAN" as const, id: user.id, sessionId: session.id };
  const bytes = Buffer.alloc(1024 * 1024, 37);
  const upload = await uploadBlob(repo.id, Readable.from([bytes]));
  const changeset = await createCanonicalChangeset(repo.id, actor, {
    apiVersion: 2, parents: [], description: "External content integrity restore fixture",
    operations: [{ kind: "ADD", path: "restore.bin", objectId: upload.id }],
  });
  await mutateReference(repo.id, actor, { name: "dev", kind: "BRANCH",
    operation: "CREATE", mutationId: "restore-fixture-" + suffix,
    expectedGeneration: null, changesetId: changeset.id });
  console.log(JSON.stringify({ repositoryId: repo.id, changesetId: changeset.id,
    storedBlobId: upload.id, bytes: bytes.length }));
} finally { await db.$disconnect(); }

import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, randomUUID, createHash } from "node:crypto";
import { db } from "../src/lib/prisma";
import { testSession } from "./support/identities";
import { stageCanonicalBlob, createCanonicalChangeset } from "../src/source-control/canonical";
import { mutateReferencesBatch } from "../src/source-control/refs";
import { bootstrapProtectedBranch } from "../src/integration/bootstrap";
import { SourceControlError } from "../src/source-control/contracts";
import { snapshotFor } from "../src/validation/snapshot";
import { configurationDigest, recipes, fingerprint, signTask } from "../src/validation/policy";

test("protected Git refs require actual signed post and exact-target checks plus human review", {
  timeout: 120000,
}, async () => {
  const suffix = randomBytes(5).toString("hex");
  const user = await db.user.create({ data: {
    handle: "gitprotected-" + suffix, email: "gitprotected-" + suffix + "@example.invalid",
  } });
  const repo = await db.repository.create({ data: {
    ownerId: user.id, slug: "gitprotected-" + suffix, name: "Git protected policy", defaultBranch: "main",
  } });
  const { actor: owner } = await testSession(user.id);
  const token = "dvg_" + randomBytes(32).toString("base64url");
  const credential = await db.gitInteropCredential.create({ data: {
    repositoryId: repo.id, userId: user.id,
    tokenHash: createHash("sha256").update(token).digest("hex"),
    scopes: ["source:read", "changeset:write", "ref:update", "admin"],
    expiresAt: new Date(Date.now() + 3600000),
  } });
  const actor = { type: "HUMAN" as const, id: user.id, gitCredentialId: credential.id };
  const original = await stageCanonicalBlob(repo.id, owner, Buffer.from("root").toString("base64"));
  const changed = await stageCanonicalBlob(repo.id, owner, Buffer.from("change").toString("base64"));
  const root = await createCanonicalChangeset(repo.id, owner, {
    apiVersion: 2, parents: [], description: "Secure root",
    operations: [{ kind: "ADD", path: "README.txt", objectId: original.id }],
  });
  const updated = await createCanonicalChangeset(repo.id, owner, {
    apiVersion: 2, parents: [root.id], description: "Reviewed changeset",
    operations: [{ kind: "ADD", path: "NEXT.txt", objectId: changed.id }],
  });
  const env: Record<string, string | undefined> = {};
  const images = [
    ["VALIDATION_NODE_IMAGE", "a"],
    ["VALIDATION_SCAN_IMAGE", "b"],
    ["VALIDATION_SECRETS_IMAGE", "c"],
  ];
  for (const [name, hash] of images) {
    env[name] = process.env[name];
    process.env[name] = "registry.example.invalid/devhub/signed@sha256:" + hash.repeat(64);
  }
  env.VALIDATION_SIGNING_PUBLIC_KEY = process.env.VALIDATION_SIGNING_PUBLIC_KEY;
  const keys = generateKeyPairSync("ed25519");
  const privateKey = Buffer.from(keys.privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64");
  process.env.VALIDATION_SIGNING_PUBLIC_KEY = Buffer.from(keys.publicKey.export({
    type: "spki", format: "pem",
  })).toString("base64");

  async function signed(subject: string, target: string | null, key: string) {
    const policy = recipes();
    const snapshot = await snapshotFor(repo.id, subject, target);
    const pipelineId = randomUUID();
    const tasks = policy.map(recipe => {
      const record = {
        id: randomUUID(), pipelineId, kind: recipe.kind,
        fingerprint: fingerprint(repo.id, subject, target, snapshot.digest, snapshot.dependencyDigest, recipe),
        image: recipe.image, command: recipe.command, timeoutSeconds: recipe.timeoutSeconds,
        attempt: 1, state: "PASSED" as const, exitCode: 0, runnerId: "signed-git-fixture",
        logDigest: null, artifactDigest: null, reusedFromId: null,
      };
      return { ...record, signature: signTask(record, privateKey) };
    });
    return db.validationPipeline.create({ data: {
      id: pipelineId, repositoryId: repo.id, changesetId: subject,
      targetChangesetId: target, idempotencyKey: key, requestedBy: "HUMAN:" + user.id,
      snapshotDigest: snapshot.digest, dependencyDigest: snapshot.dependencyDigest,
      configurationDigest: configurationDigest(policy), state: "PASSED",
      tasks: { create: tasks.map(({ pipelineId: _pipelineId, ...task }) => task) },
    } });
  }
  const failedWith = (code: string) => (e: unknown) => e instanceof SourceControlError && e.code === code;
  const update = {
    name: "main", kind: "BRANCH" as const, operation: "UPDATE" as const,
    changesetId: updated.id, expectedChangesetId: root.id, expectedGeneration: 1,
    mutationId: "git-protected-update-" + suffix,
  };
  try {
    for (const id of [root.id, updated.id]) {
      await db.sourceReview.update({ where: { changesetId: id },
        data: { state: "COMPLETED", riskTier: "LOW" } });
      await db.sourceChangeApproval.create({ data: {
        changesetId: id, userId: user.id, decision: "APPROVED",
      } });
    }
    await signed(root.id, null, "git-protected-bootstrap-" + suffix);
    await bootstrapProtectedBranch(repo.id, owner, {
      name: "main", changesetId: root.id, mutationId: "bootstrap-" + suffix,
    });
    await assert.rejects(() => mutateReferencesBatch(repo.id, actor, [update]), failedWith("CHECKS_NOT_READY"));
    await signed(updated.id, null, "git-protected-post-" + suffix);
    await assert.rejects(() => mutateReferencesBatch(repo.id, actor, [update]), failedWith("TARGET_CHECKS_REQUIRED"));
    const targetPipeline = await signed(updated.id, root.id, "git-protected-target-" + suffix);
    // Signed evidence for an unrelated target is not enough.
    await mutateReferencesBatch(repo.id, actor, [update]);
    const ref = await db.sourceReference.findUniqueOrThrow({ where: {
      repositoryId_name: { repositoryId: repo.id, name: "main" },
    } });
    assert.equal(ref.changesetId, updated.id);
    assert.equal(ref.generation, 2);
    const audit = await db.auditEvent.findFirstOrThrow({ where: {
      repositoryId: repo.id, action: "reference.update",
    }, orderBy: { occurredAt: "desc" } });
    assert.match(JSON.stringify(audit.metadata), new RegExp(targetPipeline.id));
    await assert.rejects(() => mutateReferencesBatch(repo.id, actor, [{ ...update,
      mutationId: "git-protected-stale-" + suffix,
    }]), failedWith("REFERENCE_CONFLICT"));
    await assert.rejects(() => mutateReferencesBatch(repo.id, actor, [{ ...update,
      force: true, reason: "Cannot force-update protected native refs",
      expectedGeneration: 2, expectedChangesetId: updated.id,
      mutationId: "git-protected-force-" + suffix,
    }]), failedWith("PROTECTED_REFERENCE"));
  } finally {
    for (const [name, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

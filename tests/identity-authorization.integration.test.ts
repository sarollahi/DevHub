import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import { db } from "../src/lib/prisma";
import { assertRepositoryPermission, consumeRequestQuota } from "../src/lib/authorization";
import { requestIdentity, tokenHash } from "../src/lib/auth";
import { getObject } from "../src/source-control/service";
import { SourceControlError } from "../src/source-control/contracts";
import { testSession, testCredential } from "./support/identities";

const denied = (status: number) => (error: unknown) =>
  error instanceof SourceControlError && error.status === status;

test("tenant isolation, directory grants, credential revocation, and approval safety", { timeout: 60000 }, async t => {
  const suffix = randomBytes(7).toString("hex");
  const owner = await db.user.create({ data: { handle: "security-owner-" + suffix, email: "security-owner-" + suffix + "@example.invalid" } });
  const outsider = await db.user.create({ data: { handle: "security-outsider-" + suffix, email: "security-outsider-" + suffix + "@example.invalid" } });
  const member = await db.user.create({ data: { handle: "security-member-" + suffix, email: "security-member-" + suffix + "@example.invalid" } });
  const firstOrg = await db.organization.create({ data: { slug: "security-a-" + suffix, name: "Tenant A", maxRequestsPerMinute: 2 } });
  const secondOrg = await db.organization.create({ data: { slug: "security-b-" + suffix, name: "Tenant B" } });
  await db.organizationMembership.createMany({ data: [
    { organizationId: firstOrg.id, userId: owner.id, role: "OWNER" },
    { organizationId: firstOrg.id, userId: member.id, role: "MEMBER" },
    { organizationId: secondOrg.id, userId: outsider.id, role: "OWNER" },
  ] });
  const repo = await db.repository.create({ data: { ownerId: owner.id, organizationId: firstOrg.id, name: "Source A", slug: "source-a" } });
  const foreign = await db.repository.create({ data: { ownerId: outsider.id, organizationId: secondOrg.id, name: "Source B", slug: "source-b" } });
  const human = await testSession(owner.id);
  const otherHuman = await testSession(outsider.id);
  const teamHuman = await testSession(member.id);
  const team = await db.team.create({ data: { organizationId: firstOrg.id, name: "Documentation", slug: "documentation" } });
  await db.teamMembership.create({ data: { teamId: team.id, userId: member.id } });
  await db.repositoryGrant.create({ data: { repositoryId: repo.id, subjectType: "TEAM", subjectId: team.id,
    capability: "source:read", pathPrefix: "docs", effect: "ALLOW" } });
  const agent = await db.agentIdentity.create({ data: {
    ownerId: owner.id, name: "security-runner", scopes: ["changesets:read", "changesets:write"],
  } });
  const issued = await testCredential(agent.id, repo.id, owner.id, ["changesets:read", "changesets:write"]);
  const id = randomBytes(32).toString("hex");
  const expiredAgent = await db.agentCredential.create({ data: {
    agentId: agent.id, tokenHash: tokenHash(id), label: "expired", scopes: ["changesets:read"],
    expiresAt: new Date(Date.now() - 60000),
  } });

  t.after(async () => {
    await db.auditEvent.deleteMany({ where: { repositoryId: { in: [repo.id, foreign.id] } } });
    await db.repository.deleteMany({ where: { id: { in: [repo.id, foreign.id] } } });
    await db.organization.deleteMany({ where: { id: { in: [firstOrg.id, secondOrg.id] } } });
    await db.agentIdentity.delete({ where: { id: agent.id } });
    await db.humanSession.deleteMany({ where: { userId: { in: [owner.id, outsider.id, member.id] } } });
    await db.user.deleteMany({ where: { id: { in: [owner.id, outsider.id, member.id] } } });
  });

  await t.test("cross-tenant repositories and objects are inaccessible", async () => {
    await assert.rejects(() => assertRepositoryPermission(human.actor, foreign.id, "source:read"), denied(404));
    await assert.rejects(() => assertRepositoryPermission(otherHuman.actor, repo.id, "source:read"), denied(404));
    await assert.rejects(() => assertRepositoryPermission(issued.actor, foreign.id, "source:read"), denied(403));
    await assert.rejects(() => getObject(foreign.id, "f".repeat(64), human.actor), denied(404));
    await assert.rejects(() => getObject(repo.id, "f".repeat(64)), denied(401));
  });
  await t.test("directory, branch, and explicit-deny policy restrict operations", async () => {
    await assertRepositoryPermission(teamHuman.actor, repo.id, "source:read", { paths: ["docs/reference.md"] });
    await assert.rejects(() => assertRepositoryPermission(teamHuman.actor, repo.id, "source:read", { paths: ["src/private.ts"] }), denied(403));
    await assert.rejects(() => assertRepositoryPermission(teamHuman.actor, repo.id, "source:read"), denied(403));
    await assert.rejects(() => assertRepositoryPermission(human.actor, repo.id, "changeset:write", { paths: ["../secrets"] }), denied(422));
    const restriction = await db.repositoryGrant.create({ data: {
      repositoryId: repo.id, subjectType: "USER", subjectId: owner.id,
      capability: "changeset:write", pathPrefix: "secret", effect: "DENY",
    } });
    await assert.rejects(() => assertRepositoryPermission(human.actor, repo.id, "changeset:write",
      { paths: ["secret/keys.env"] }), denied(403));
    await assertRepositoryPermission(human.actor, repo.id, "changeset:write", { paths: ["docs/new.md"] });
    await db.repositoryGrant.delete({ where: { id: restriction.id } });
  });
  await t.test("delegated machines cannot approve or escalate", async () => {
    await assertRepositoryPermission(issued.actor, repo.id, "changeset:write", { paths: ["docs/new.md"] });
    await assert.rejects(() => assertRepositoryPermission(issued.actor, repo.id, "review"), denied(403));
    await assert.rejects(() => assertRepositoryPermission(issued.actor, repo.id, "admin"), denied(403));
    await assert.rejects(() => assertRepositoryPermission(issued.actor, repo.id, "ref:update", { branch: "main" }), denied(403));
    await db.agentDelegation.updateMany({ where: { agentId: agent.id }, data: { revokedAt: new Date() } });
    await assert.rejects(() => assertRepositoryPermission(issued.actor, repo.id, "source:read"), denied(403));
  });
  await t.test("revocation and expiration are checked on every authentication", async () => {
    const request = (raw: string) => new NextRequest("http://localhost:3000/api/v2/repositories/" + repo.id,
      { headers: { authorization: "Bearer " + raw } });
    assert.equal((await requestIdentity(request(issued.raw)))?.id, agent.id);
    assert.equal(await requestIdentity(request(id)), null);
    await db.agentCredential.update({ where: { id: issued.credential.id }, data: { revokedAt: new Date() } });
    assert.equal(await requestIdentity(request(issued.raw)), null);
    await assert.rejects(() => assertRepositoryPermission(issued.actor, repo.id, "source:read"), denied(401));
    await db.humanSession.update({ where: { id: teamHuman.actor.sessionId }, data: { revokedAt: new Date() } });
    await assert.rejects(() => assertRepositoryPermission(teamHuman.actor, repo.id, "source:read", { paths: ["docs/valid.md"] }), denied(401));
    assert.ok(expiredAgent.id);
  });
  await t.test("request quota is atomic per tenant and caller", async () => {
    await consumeRequestQuota(repo.id, human.actor);
    await consumeRequestQuota(repo.id, human.actor);
    await assert.rejects(() => consumeRequestQuota(repo.id, human.actor), denied(429));
  });
});

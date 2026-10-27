# Identity and authorization

## Security model

The source-control authority treats every request as a **human session** or an **expiring machine credential**. HTTP routes perform an early guard, but object reads, changeset publication, blob staging, approvals and reference updates validate identity again in the source-control service. Mutation policies are rechecked inside the database transaction. Client claims, generated review text and model judgments never supply a human approval.

**Capabilities**: `source:read`, `changeset:write`, `ref:update`, `review`, and `admin`. Grant records specify a user, team or machine principal; effect (`ALLOW` or `DENY`), optional branch/path restrictions and expiration. Explicit denies override positive role grants. Owners and organization administrators have operational rights but must still satisfy explicit denial policies. Only authenticated humans can perform reviews or administration.

**Tenants**: a repository belongs to one organization or a legacy individual owner. Organization members are the only human principals eligible for access to an organization-owned repository. Teams cannot cross organization boundaries. Machines require three separate conditions: active identity with the scope, unexpired credential with the same scope, and an active repository-specific delegation from a current administrator. Credentials alone cannot expand tenant access.

A content-addressed blob hash is *not* proof of authorization. Object retrieval checks the caller's repository access and the repository's own object grant. Never return a global deduplicated object merely because its SHA-256 is known.

## Provisioning and first launch

```sh
cp .env.example .env
# Supply BOOTSTRAP_USER_PASSWORD and BOOTSTRAP_AGENT_TOKEN using a secrets manager.
docker compose up -d --wait
npm ci
npm run db:generate
npm run db:deploy
npm run db:seed
npm run dev
```

Seed creates the initial individual account, organization owner, repository and time-limited machine delegation. The seed is for local development; production users must be provisioned intentionally. Visit `/login` using the provisioned email and password. Use `/access` to administer access. Do **not** deploy a shared administrator bearer token. Legacy credentials without explicit expiry and scoped delegation are deliberately invalid.

### APIs

- `GET/POST /api/v1/organizations`: organizations visible to the signed-in user; create tenant.
- `POST /api/v1/organizations/{id}/users`: administrator provisions a human account.
- `GET/POST /api/v1/organizations/{id}/members`: members and roles; a last owner cannot be downgraded.
- `GET/POST /api/v1/organizations/{id}/teams`; `POST/DELETE /api/v1/organizations/{id}/teams/{teamId}/members`: team administration.
- `GET/POST /api/v1/machines`: machine identities. `POST /api/v1/machines/{id}/credentials` returns a one-time plaintext token for five to sixty minutes. `DELETE /api/v1/machines/{id}/credentials/{credentialId}` revokes it; `PATCH /api/v1/machines/{id}` suspends/revokes identity.
- `GET/POST /api/v1/repositories/{id}/access` and `DELETE /api/v1/repositories/{id}/access/{grantId}`: grant rules.
- `GET/POST /api/v1/repositories/{id}/delegations` and `DELETE /api/v1/repositories/{id}/delegations/{delegationId}`: time-bounded machine delegation.
- `GET /api/v1/repositories/{id}/audit`: repository security events.

Machine credentials are hashed at rest; the token is visible only on issuance. Revoke old credentials or use credential rotation with a brief planned overlap. Revoke delegations separately after agent/CI jobs finish.

### Production configuration

1. Terminate **TLS** at a trusted reverse proxy, enable HSTS, restrict proxy-forwarded headers, and do not expose PostgreSQL or Redis. Serve the application on a single canonical origin so the session cookie's strict same-site and origin checks are reliable.
2. Store `DATABASE_URL`, `REDIS_URL`, `BOOTSTRAP_USER_PASSWORD`, and initial credentials outside source control. Use strong, unique passwords and random tokens. Avoid running the bootstrap seed on every deployment; remove bootstrap variables after initialization.
3. Create distinct human accounts instead of shared identities. Restrict administrators; review organization memberships, denies, delegated machine permissions and expiry on a schedule.
4. Human sessions expire after eight hours and are revocable. Machine credentials expire within 60 minutes. External jobs must refresh credentials through an approved management workflow; do not turn off expiry on CI failures.
5. Set organization request rates, repository quotas and size limits deliberately. Monitor quota exhaustion, denied cross-tenant requests, authentication failures and retry surges. Put additional upstream IP-based rate limits and WAF controls at the ingress.
6. Configure reliable PostgreSQL backups, encryption at rest, database auditing and centralized log retention. Restrict direct database mutation permissions to the application; audit rows should be replicated to append-only security logging for tamper evidence.
7. Protect default/release branches with required validation and human review. Never accept an agent-generated result as proof of human consent. Keep workers isolated from secrets, credentials and administrative endpoints.
8. Set up security scanning, dependency review and independent penetration testing before public exposure. The local stack is not a substitute for production threat-model review.

### Known limits and migration

The migration is additive: existing repositories initially retain legacy owner association, while the development seed associates its repository with a new organization. Existing machine tokens without an expiration are **not** grandfathered into the new trust model. Explicitly reissue scoped credentials and delegations before restarting CI agents.

Membership roles and grants cannot currently express custom attribute predicates or organizational nested teams. Token issuance uses the application database as the authoritative revocation source. Rate limits use PostgreSQL-backed counters; for higher-volume environments consider a distributed limiter that preserves the same fail-closed ceiling. Quota counters protect canonical blob staging; legacy object writers should be migrated to the canonical pipeline before large-scale public uploads.

## Verification

Run `npm run typecheck`, `npm run test:integration`, `npm run build`, `npx prisma validate` and `npx prisma migrate status`. Security regression tests cover unapproved object reads, cross-organization access, directory/branch policies, expired and revoked tokens, agent privileges, and rate budgets. Review CI and dependency/security findings before removing draft status or merging.

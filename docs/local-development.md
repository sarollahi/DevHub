# Local development and verification

Prerequisites: Node.js >= 22.18, npm, Docker with Compose, and local ports 5432 and 6379.

```sh
cp .env.example .env
# Replace all placeholder credentials in .env with independent 32+ character secrets.
docker compose up -d --wait
npm ci
npm run db:generate
npm run db:deploy
npx prisma validate
npx prisma migrate status
npm run typecheck
npm test
npm run test:integration
npm run build
```

Run four processes (separate terminals): `npm run dev`, `npm run dispatcher`, `npm run worker`, and `npm run worker:review`. Use `npm run db:seed` to create the initial administrator-owned repository and an authenticated agent; the seed reads `BOOTSTRAP_AGENT_TOKEN` and stores only its digest. The HTTP health check is `GET /api/health`.

CI provisions real PostgreSQL 16 and Redis 7 services, applies checked-in migrations, runs the integration suite against both services, validates TypeScript, builds the application and boots the HTTP server. `npm ci` is the sole dependency installation path after the one-time lockfile bootstrap. The secret scan inspects committed history. A green build is not evidence of actual source-code execution or completed merges; the initial PR merge endpoint remains intentionally disabled until a native source-control coordinator exists.

Never commit `.env`, runtime credentials, DB exports or build output. Use separate secrets for production. Run `docker compose down` to stop the containers.

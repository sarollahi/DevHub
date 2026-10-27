/**
 * Authorized, resumable checkpoint migration client. No background work:
 * this process prints progress and terminates on completion or any error.
 * Server progress remains durable across client and worker restarts.
 */
const args = new Map(process.argv.slice(2).map(arg => {
  const [key, ...rest] = arg.replace(/^--/, "").split("=");
  return [key, rest.join("=")];
}));
function option(name: string, fallback?: string) {
  const value = args.get(name) || fallback;
  if (!value) throw Error("Missing --" + name);
  return value;
}
const origin = option("url", process.env.DEVHUB_URL || "http://localhost:3000").replace(/\/$/, "");
const repositoryId = option("repository");
const changesetId = option("revision");
const token = process.env.DEVHUB_AUTH_TOKEN;
if (!token) throw Error("DEVHUB_AUTH_TOKEN must be set");
const maxRounds = Number(option("max-rounds", "100000"));
if (!Number.isSafeInteger(maxRounds) || maxRounds < 1) throw Error("Invalid max-rounds");
const url = origin + "/api/v2/repositories/" + encodeURIComponent(repositoryId) +
  "/changesets/" + encodeURIComponent(changesetId) + "/snapshot?discover=512&apply=64";
let finished = false;
for (let round = 0; round < maxRounds; round++) {
  const response = await fetch(url, { method: "POST",
    headers: { Authorization: "Bearer " + token, "content-type": "application/json" } });
  const payload = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    throw Error("Migration HTTP " + response.status + ": " + JSON.stringify(payload));
  }
  const progress = { round: round + 1, phase: payload.phase, discovered: payload.discovered,
    applied: payload.applied, materialized: payload.materialized,
    ...(payload.materialized ? { rootId: payload.rootId, pathCount: payload.pathCount } : {}) };
  process.stdout.write(JSON.stringify(progress) + "\n");
  if (payload.materialized === true) { finished = true; break; }
}
if (!finished) throw Error("Migration budget exhausted; progress remains durable for a later invocation");

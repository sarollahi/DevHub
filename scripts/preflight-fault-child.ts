import { processPreflight } from "../src/workers/processor";
import { db } from "../src/lib/prisma";

const [jobId, pullId, version] = process.argv.slice(2);
if (!jobId || !pullId || !Number(version)) throw Error("Missing durable job payload");
await processPreflight({ jobId, pullId, version: Number(version) });
await db.$disconnect();

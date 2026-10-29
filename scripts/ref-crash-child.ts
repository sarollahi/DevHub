import { mutateReference } from "../src/source-control/refs";
import { db } from "../src/lib/prisma";

const [repositoryId, userId, sessionId, sourceId, generation, mutationId] = process.argv.slice(2);
if (!repositoryId || !userId || !sessionId || !sourceId || !generation || !mutationId)
  throw Error("Missing source mutation crash fixture");
const actor = { type: "HUMAN" as const, id: userId, sessionId };
process.stdout.write("REF_MUTATION_STARTED\n");
await mutateReference(repositoryId, actor, {
  name: "dev", kind: "BRANCH", operation: "UPDATE", changesetId: sourceId,
  expectedGeneration: Number(generation), mutationId,
});
await db.$disconnect();

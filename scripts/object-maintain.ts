import { cleanupObjects, recoverPublications } from "../src/object-store/service";

// Run under a single scheduler or in --loop mode; every operation is idempotent.
// Failed operations remain durable for the next invocation.
async function cycle() {
  const recovered = await recoverPublications();
  const cleaned = await cleanupObjects();
  console.info(JSON.stringify({ event: "object_storage.maintenance", recovered, ...cleaned }));
}
if (process.argv.includes("--loop")) {
  for (;;) {
    await cycle().catch(error => { console.error("Object maintenance failed", error); });
    await new Promise(resolve => setTimeout(resolve, 5 * 60 * 1000));
  }
} else {
  await cycle();
}

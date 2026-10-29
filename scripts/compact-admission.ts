import { db } from "../src/lib/prisma";

const hours = Number(process.argv.find(x => x.startsWith("--keep-hours="))?.slice(13) ?? 48);
if (!Number.isSafeInteger(hours) || hours < 2 || hours > 720) {
  throw new Error("--keep-hours must be an integer from 2 to 720");
}
try {
  const [actorBuckets, tenantBuckets] = await db.$transaction(async tx => {
    // DB clock and a conservative retention period; never delete currently
    // active/previous admission windows while other replicas write.
    const threshold = new Date(Date.now() - hours * 3600_000);
    return Promise.all([
      tx.apiRateBucket.deleteMany({ where: { windowStart: { lt: threshold } } }),
      tx.tenantRateBucket.deleteMany({ where: { windowStart: { lt: threshold } } }),
    ]);
  });
  console.log(JSON.stringify({ event: "admission_buckets_compacted", keepHours: hours,
    actorBuckets: actorBuckets.count, tenantBuckets: tenantBuckets.count }));
} finally { await db.$disconnect(); }

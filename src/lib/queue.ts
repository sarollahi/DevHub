import { Queue } from "bullmq";
import IORedis from "ioredis";

export const QUEUE_NAME = "pr-processing";
export type ProcessMessage = { jobId: string; pullId: string; version: number };
export function redisConnection() {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is required");
  return new IORedis(url, { maxRetriesPerRequest: null, enableReadyCheck: true });
}
export function createQueue(connection = redisConnection()) {
  return new Queue<ProcessMessage>(QUEUE_NAME, { connection, defaultJobOptions: {
    attempts: 5, backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: { age: 604800, count: 100000 },
    removeOnFail: { age: 604800, count: 100000 },
  } });
}

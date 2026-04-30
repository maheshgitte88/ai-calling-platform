import IORedis from "ioredis";
import { Queue, Worker } from "bullmq";
import { env } from "./config.js";

/** Redis connection for BullMQ - ioredis handles REDIS_URL directly */
const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });

/**
 * BullMQ queue for call jobs
 */
export const callQueue = new Queue("calls", {
  connection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: { count: 1000 },
  },
});

/**
 * Create call worker - will be used in worker.js
 */
export function createCallWorker(processFn) {
  return new Worker("calls", processFn, {
    connection,
    concurrency: env.CAMPAIGN_CONCURRENCY,
  });
}

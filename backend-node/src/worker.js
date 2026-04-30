/**
 * BullMQ worker - processes call jobs.
 * In this architecture, calls are dispatched directly via LiveKit agent dispatch.
 * The worker can be used for pre-processing or async tasks if needed.
 * For now, the API enqueues calls directly via createDispatch - no separate worker queue needed.
 * This worker is kept for future bulk processing / rate limiting / retries.
 */
import IORedis from "ioredis";
import { Worker } from "bullmq";
import { connectDb } from "./db.js";
import { env } from "./config.js";

const connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });

async function processCallJob(job) {
  // Job data: { callId, clientId, phone, ... } - for future async processing
  console.log(`[Worker] Processing job ${job.id}`, job.data);
  return { processed: true };
}

async function main() {
  await connectDb();

  const worker = new Worker("calls", processCallJob, {
    connection,
    concurrency: env.CAMPAIGN_CONCURRENCY,
  });

  worker.on("completed", (job) => console.log(`[Worker] Job ${job.id} completed`));
  worker.on("failed", (job, err) => console.error(`[Worker] Job ${job?.id} failed:`, err));

  console.log("BullMQ worker started");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

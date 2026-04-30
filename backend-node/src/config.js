import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({ path: ".env.local" });
dotenv.config();

const EnvSchema = z.object({
  // LiveKit
  LIVEKIT_URL: z.string().min(1),
  LIVEKIT_API_KEY: z.string().min(1),
  LIVEKIT_API_SECRET: z.string().min(1),
  AGENT_NAME: z.string().default("ai-calling-agent"),

  // MongoDB
  MONGODB_URI: z.string().default("mongodb://localhost:27017/ai_calling"),

  // Redis (BullMQ)
  REDIS_URL: z.string().default("redis://localhost:6379"),

  // Server
  PORT: z.coerce.number().default(4040),

  // Limits
  CAMPAIGN_CONCURRENCY: z.coerce.number().default(5),
  MAX_CALL_SECONDS: z.coerce.number().default(300),
  UPLOAD_DIR: z.string().default("./uploads"),
});

export const env = EnvSchema.parse(process.env);

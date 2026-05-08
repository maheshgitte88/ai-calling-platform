import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(backendRoot, ".env.local") });
dotenv.config({ path: path.join(backendRoot, ".env") });

const EnvSchema = z.object({
  // LiveKit
  LIVEKIT_URL: z.string().min(1),
  LIVEKIT_PUBLIC_URL: z.string().optional(),
  LIVEKIT_API_KEY: z.string().min(1),
  LIVEKIT_API_SECRET: z.string().min(1),
  AGENT_NAME: z.string().default("ai-interview-agent"),
  INTERVIEW_AGENT_NAME: z.string().optional(),

  // MongoDB
  MONGODB_URI: z.string().default("mongodb://localhost:27017/ai_calling"),

  // Server
  PORT: z.coerce.number().default(4040),
  APP_BASE_URL: z.string().default("http://localhost:3000"),
  INTERVIEW_JOIN_TOKEN_SECRET: z.string().optional(),
  AZURE_STORAGE_ACCOUNT_NAME: z.string().optional(),
  AZURE_STORAGE_ACCOUNT_KEY: z.string().optional(),
  AZURE_STORAGE_CONTAINER_NAME: z.string().default("interview-recordings"),

});

const parsedEnv = EnvSchema.parse(process.env);

export const env = {
  ...parsedEnv,
  // Server containers can use ws://livekit:7880, but browser clients need a
  // host-reachable URL such as ws://localhost:7880 or a public EC2/domain URL.
  LIVEKIT_PUBLIC_URL: parsedEnv.LIVEKIT_PUBLIC_URL ||  parsedEnv.LIVEKIT_URL,
};

import { MongoClient } from "mongodb";
import { env } from "./config.js";

/** @type {MongoClient} */
let client;
/** @type {import("mongodb").Db} */
let db;

/**
 * Connect to MongoDB and return the database instance.
 */
export async function connectDb() {
  if (db) return db;
  client = new MongoClient(env.MONGODB_URI);
  await client.connect();
  db = client.db();
  return db;
}

/**
 * Get the MongoDB database instance. Must call connectDb() first.
 */
export function getDb() {
  if (!db) throw new Error("Database not connected. Call connectDb() first.");
  return db;
}

/**
 * Collection names
 */
export const COLLECTIONS = {
  INTERVIEWS: "interviews",
  INTERVIEW_SESSIONS: "interview_sessions",
  INTERVIEW_EVENTS: "interview_events",
  INTERVIEW_EVALUATIONS: "interview_evaluations",
  INTERVIEW_PROCTOR_FRAMES: "interview_proctor_frames",
  PROVIDERS: "providers",
  USERS: "users",
};

/**
 * Create indexes for performance
 */
export async function createIndexes() {
  const d = getDb();

  await d.collection(COLLECTIONS.INTERVIEW_SESSIONS).createIndex({ session_id: 1 }, { unique: true });
  await d.collection(COLLECTIONS.INTERVIEW_SESSIONS).createIndex({ interview_id: 1, candidate_id: 1 });
  await d.collection(COLLECTIONS.INTERVIEW_SESSIONS).createIndex({ created_at: -1 });
  await d.collection(COLLECTIONS.INTERVIEW_EVENTS).createIndex({ session_id: 1, created_at: 1 });
  await d.collection(COLLECTIONS.INTERVIEW_EVALUATIONS).createIndex({ session_id: 1 }, { unique: true });
  await d.collection(COLLECTIONS.INTERVIEW_PROCTOR_FRAMES).createIndex({ session_id: 1, captured_at: 1 });
  await d.collection(COLLECTIONS.INTERVIEW_PROCTOR_FRAMES).createIndex({ session_id: 1, created_at: -1 });
}

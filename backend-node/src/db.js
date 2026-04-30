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
  CLIENTS: "clients",
  CLIENT_CONFIGS: "client_configs",
  CAMPAIGNS: "campaigns",
  CONTACTS: "contacts",
  CALLS: "calls",
  TRANSCRIPT_ENTRIES: "transcript_entries",
  PROVIDERS: "providers",
  USERS: "users",
};

/**
 * Create indexes for performance
 */
export async function createIndexes() {
  const d = getDb();

  await d.collection(COLLECTIONS.CALLS).createIndex({ client_id: 1 });
  await d.collection(COLLECTIONS.CALLS).createIndex({ status: 1 });
  await d.collection(COLLECTIONS.CALLS).createIndex({ created_at: -1 });
  await d.collection(COLLECTIONS.CONTACTS).createIndex({ campaign_id: 1 });
  await d.collection(COLLECTIONS.CLIENTS).createIndex({ created_at: -1 });
  await d.collection(COLLECTIONS.CAMPAIGNS).createIndex({ client_id: 1 });
}

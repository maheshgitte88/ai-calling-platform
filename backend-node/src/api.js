import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { getDb, COLLECTIONS } from "./db.js";
import { createDispatch, cancelDispatch } from "./livekit.js";
import { callQueue } from "./queues.js";
import { parseContactsFromSheet, safeRemoveFile } from "./excel.js";
import { LLM_PROVIDERS, STT_PROVIDERS, TTS_PROVIDERS, SIP_PROVIDERS } from "./providers.js";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// Ensure upload dir exists
const UPLOAD_DIR = process.env.UPLOAD_DIR || "./uploads";
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const upload = multer({ dest: UPLOAD_DIR });

function digitsOnly(value) {
  return value.replace(/\D/g, "");
}

function nowIso() {
  return new Date().toISOString();
}

// ----- Schemas -----
const CreateClientSchema = z.object({
  name: z.string().min(1),
  systemPrompt: z.string().min(1),
  summaryPrompt: z.string().default("Summarize the call with outcome, objections, and next actions."),
  extractionSchema: z.record(z.string()).default({}),
});

const ClientConfigSchema = z.object({
  clientId: z.string().min(1).optional(),
  llm: z.object({
    provider: z.string().min(1),
    apiKey: z.string().optional(), // can be empty/"***" when keeping existing
    model: z.string().min(1),
  }),
  stt: z.object({
    provider: z.string().min(1),
    apiKey: z.string().optional(),
    model: z.string().optional(),
    language: z.string().nullish(),
    mode: z.string().nullish(),
  }),
  tts: z.object({
    provider: z.string().min(1),
    apiKey: z.string().optional(),
    voice: z.string().min(1),
    model: z.string().optional(),
    targetLanguageCode: z.string().nullish(),
  }),
  sip: z.object({
    provider: z.string().min(1),
    trunkId: z.string().min(1),
    fromNumber: z.string().optional(),
  }),
  rateLimit: z.number().optional(),
  concurrencyLimit: z.number().optional(),
});

const CreateCallSchema = z.object({
  clientId: z.string().min(1),
  phone: z.string().min(5),
  name: z.string().optional(),
  campaignId: z.string().optional(),
  contactId: z.string().optional(),
  promptOverride: z.string().optional(),
  providerConfig: z.object({
    llm: z.object({
      provider: z.string().optional(),
      apiKey: z.string().optional(),
      model: z.string().optional(),
    }).partial().optional(),
    stt: z.object({
      provider: z.string().optional(),
      apiKey: z.string().optional(),
      model: z.string().optional(),
      language: z.string().nullish(),
      mode: z.string().nullish(),
    }).partial().optional(),
    tts: z.object({
      provider: z.string().optional(),
      apiKey: z.string().optional(),
      voice: z.string().optional(),
      model: z.string().optional(),
      targetLanguageCode: z.string().nullish(),
    }).partial().optional(),
    sip: z.object({
      provider: z.string().optional(),
      trunkId: z.string().optional(),
      fromNumber: z.string().optional(),
    }).partial().optional(),
  }).partial().optional(),
  metadata: z.record(z.unknown()).default({}),
});

const BulkCallsSchema = z.object({
  clientId: z.string().min(1),
  contacts: z.array(z.object({
    phone: z.string().min(5),
    name: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
  })).min(1).max(1000),
  campaignId: z.string().optional(),
  providerConfig: z.object({
    llm: z.object({
      provider: z.string().optional(),
      apiKey: z.string().optional(),
      model: z.string().optional(),
    }).partial().optional(),
    stt: z.object({
      provider: z.string().optional(),
      apiKey: z.string().optional(),
      model: z.string().optional(),
      language: z.string().nullish(),
      mode: z.string().nullish(),
    }).partial().optional(),
    tts: z.object({
      provider: z.string().optional(),
      apiKey: z.string().optional(),
      voice: z.string().optional(),
      model: z.string().optional(),
      targetLanguageCode: z.string().nullish(),
    }).partial().optional(),
    sip: z.object({
      provider: z.string().optional(),
      trunkId: z.string().optional(),
      fromNumber: z.string().optional(),
    }).partial().optional(),
  }).partial().optional(),
});

// ----- Health -----
app.get("/health", (_, res) => res.json({ ok: true }));

// ----- Provider metadata (for dashboard) -----
app.get("/api/providers", (_, res) => {
  res.json({ llm: LLM_PROVIDERS, stt: STT_PROVIDERS, tts: TTS_PROVIDERS, sip: SIP_PROVIDERS });
});

// ----- Clients -----
app.post("/api/clients", async (req, res) => {
  try {
    const payload = CreateClientSchema.parse(req.body);
    const id = uuidv4();
    const db = getDb();
    await db.collection(COLLECTIONS.CLIENTS).insertOne({
      id,
      name: payload.name,
      system_prompt: payload.systemPrompt,
      summary_prompt: payload.summaryPrompt,
      extraction_schema: payload.extractionSchema,
      created_at: nowIso(),
    });
    res.status(201).json({ id });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/clients", async (_, res) => {
  const db = getDb();
  const items = await db.collection(COLLECTIONS.CLIENTS).find().sort({ created_at: -1 }).limit(200).toArray();
  res.json({ items });
});

app.get("/api/clients/:id", async (req, res) => {
  const db = getDb();
  const client = await db.collection(COLLECTIONS.CLIENTS).findOne({ id: req.params.id });
  if (!client) return res.status(404).json({ error: "Client not found" });
  res.json(client);
});

app.get("/api/clients/:id/stats", async (req, res) => {
  const db = getDb();
  const client = await db.collection(COLLECTIONS.CLIENTS).findOne({ id: req.params.id });
  if (!client) return res.status(404).json({ error: "Client not found" });

  const calls = await db
    .collection(COLLECTIONS.CALLS)
    .aggregate([
      { $match: { client_id: req.params.id } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ])
    .toArray();

  const stats = {
    total: 0,
    queued: 0,
    dispatched: 0,
    in_progress: 0,
    completed: 0,
    failed: 0,
  };
  for (const row of calls) {
    const key = row._id === "in-progress" ? "in_progress" : row._id;
    if (Object.prototype.hasOwnProperty.call(stats, key)) {
      stats[key] = row.count;
      stats.total += row.count;
    }
  }
  res.json(stats);
});

app.patch("/api/clients/:id", async (req, res) => {
  try {
    const db = getDb();
    const existing = await db.collection(COLLECTIONS.CLIENTS).findOne({ id: req.params.id });
    if (!existing) return res.status(404).json({ error: "Client not found" });

    const payload = CreateClientSchema.partial().parse(req.body);
    const update = {};
    if (payload.name !== undefined) update.name = payload.name;
    if (payload.systemPrompt !== undefined) update.system_prompt = payload.systemPrompt;
    if (payload.summaryPrompt !== undefined) update.summary_prompt = payload.summaryPrompt;
    if (payload.extractionSchema !== undefined) update.extraction_schema = payload.extractionSchema;

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: "At least one field required" });
    }
    update.updated_at = nowIso();

    await db.collection(COLLECTIONS.CLIENTS).updateOne({ id: req.params.id }, { $set: update });
    res.json({ id: req.params.id, updated: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ----- Client Config (LLM, STT, TTS, SIP per client) -----
app.get("/api/clients/:clientId/config", async (req, res) => {
  const db = getDb();
  const config = await db.collection(COLLECTIONS.CLIENT_CONFIGS).findOne({ client_id: req.params.clientId });
  if (!config) return res.status(404).json({ error: "Config not found" });
  // Mask API keys in response
  const safe = { ...config };
  if (safe.llm?.apiKey) safe.llm.apiKey = "***";
  if (safe.stt?.apiKey) safe.stt.apiKey = "***";
  if (safe.tts?.apiKey) safe.tts.apiKey = "***";
  res.json(safe);
});

app.post("/api/clients/:clientId/config", async (req, res) => {
  try {
    const db = getDb();
    const client = await db.collection(COLLECTIONS.CLIENTS).findOne({ id: req.params.clientId });
    if (!client) return res.status(404).json({ error: "Client not found" });

    const payload = ClientConfigSchema.omit({ clientId: true }).parse(req.body);
    const existing = await db.collection(COLLECTIONS.CLIENT_CONFIGS).findOne({ client_id: req.params.clientId });

    const keepIfMasked = (val, existingVal) =>
      !val || val === "***" ? (existingVal || val) : val;

    const doc = {
      client_id: req.params.clientId,
      llm: {
        ...payload.llm,
        apiKey: keepIfMasked(payload.llm?.apiKey, existing?.llm?.apiKey) || payload.llm.apiKey,
      },
      stt: {
        ...payload.stt,
        apiKey: keepIfMasked(payload.stt?.apiKey, existing?.stt?.apiKey) || payload.stt.apiKey,
        language: payload.stt?.language ?? existing?.stt?.language,
        mode: payload.stt?.mode ?? existing?.stt?.mode,
      },
      tts: {
        ...payload.tts,
        apiKey: keepIfMasked(payload.tts?.apiKey, existing?.tts?.apiKey) || payload.tts.apiKey,
        targetLanguageCode: payload.tts?.targetLanguageCode ?? existing?.tts?.targetLanguageCode,
      },
      sip: payload.sip,
      rate_limit: payload.rateLimit ?? 100,
      concurrency_limit: payload.concurrencyLimit ?? 5,
      updated_at: nowIso(),
    };

    await db.collection(COLLECTIONS.CLIENT_CONFIGS).updateOne(
      { client_id: req.params.clientId },
      { $set: doc },
      { upsert: true }
    );
    res.json({ updated: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ----- Single Call -----
async function enqueueCall(payload) {
  const db = getDb();
  const client = await db.collection(COLLECTIONS.CLIENTS).findOne({ id: payload.clientId });
  if (!client) throw new Error(`Client not found: ${payload.clientId}`);

  const callId = uuidv4();
  const roomName = `call-${digitsOnly(payload.phone)}-${Math.floor(Math.random() * 9000 + 1000)}`;

  await db.collection(COLLECTIONS.CALLS).insertOne({
    id: callId,
    client_id: payload.clientId,
    campaign_id: payload.campaignId ?? null,
    contact_id: payload.contactId ?? null,
    room_name: roomName,
    phone: payload.phone,
    status: "queued",
    metadata: payload.metadata ?? {},
    created_at: nowIso(),
    updated_at: nowIso(),
  });

  const callMetadata = {
    callId,
    clientId: payload.clientId,
    phone: payload.phone,
    contactName: payload.name ?? "",
    prompt: payload.promptOverride ?? client.system_prompt,
    summaryPrompt: client.summary_prompt ?? "Summarize the call.",
    extractionSchema: client.extraction_schema ?? {},
    providerConfig: payload.providerConfig ?? null,
  };

  const { dispatchId } = await createDispatch({ roomName, callMetadata });

  await db.collection(COLLECTIONS.CALLS).updateOne(
    { id: callId },
    { $set: { dispatch_id: dispatchId, status: "dispatched", updated_at: nowIso() } }
  );

  return { callId, roomName, dispatchId };
}

app.post("/api/calls", async (req, res) => {
  try {
    const payload = CreateCallSchema.parse(req.body);
    const result = await enqueueCall(payload);
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ----- Bulk Calls (API: single endpoint, 1 or many records) -----
app.post("/api/calls/bulk", async (req, res) => {
  try {
    const payload = BulkCallsSchema.parse(req.body);
    const db = getDb();
    const client = await db.collection(COLLECTIONS.CLIENTS).findOne({ id: payload.clientId });
    if (!client) return res.status(404).json({ error: "Client not found" });

    const jobIds = [];
    for (const c of payload.contacts) {
      const callPayload = {
        clientId: payload.clientId,
        phone: c.phone,
        name: c.name,
        campaignId: payload.campaignId,
        providerConfig: payload.providerConfig,
        metadata: c.metadata ?? {},
      };
      const result = await enqueueCall(callPayload);
      jobIds.push(result.callId);
    }

    res.status(201).json({ callIds: jobIds, count: jobIds.length });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ----- Calls list & detail -----
app.get("/api/calls", async (req, res) => {
  const db = getDb();
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
  const clientId = req.query.clientId;
  const filter = clientId ? { client_id: clientId } : {};
  const items = await db.collection(COLLECTIONS.CALLS).find(filter).sort({ created_at: -1 }).limit(limit).toArray();
  res.json({ items });
});

app.get("/api/calls/:id", async (req, res) => {
  const db = getDb();
  const call = await db.collection(COLLECTIONS.CALLS).findOne({ id: req.params.id });
  if (!call) return res.status(404).json({ error: "Call not found" });

  const entries = await db.collection(COLLECTIONS.TRANSCRIPT_ENTRIES).find({ call_id: req.params.id }).sort({ created_at: 1 }).toArray();
  res.json({ ...call, transcriptEntries: entries });
});

app.delete("/api/calls/:id", async (req, res) => {
  try {
    const db = getDb();
    const call = await db.collection(COLLECTIONS.CALLS).findOne({ id: req.params.id });
    if (!call) return res.status(404).json({ error: "Call not found" });
    if (!["queued", "dispatched"].includes(call.status)) {
      return res.status(400).json({ error: "Only queued/dispatched calls can be deleted" });
    }

    if (call.dispatch_id) {
      try {
        await cancelDispatch(call.dispatch_id);
      } catch {
        // best-effort: still allow deleting local pending call record
      }
    }

    await db.collection(COLLECTIONS.CALLS).deleteOne({ id: req.params.id });
    await db.collection(COLLECTIONS.TRANSCRIPT_ENTRIES).deleteMany({ call_id: req.params.id });
    res.json({ ok: true, id: req.params.id });
  } catch (err) {
    res.status(500).json({ error: err.message || "Delete failed" });
  }
});

// Recover stuck call: generate summary/extraction from transcript_entries when call ended without summary
app.post("/api/calls/:id/recover-summary", async (req, res) => {
  try {
    const { spawn } = await import("node:child_process");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const scriptPath = path.resolve(__dirname, "..", "..", "agent-python", "recover_stuck_calls.py");
    await new Promise((resolve, reject) => {
      const proc = spawn("python", [scriptPath, req.params.id], {
        cwd: path.dirname(scriptPath),
        env: { ...process.env, MONGODB_URI: process.env.MONGODB_URI },
      });
      let err = "";
      proc.stderr?.on("data", (d) => { err += d.toString(); });
      proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err || `exit ${code}`))));
    });
    const db = getDb();
    const updated = await db.collection(COLLECTIONS.CALLS).findOne({ id: req.params.id });
    res.json({ ok: true, call: updated });
  } catch (err) {
    res.status(500).json({ error: err.message || "Recovery failed" });
  }
});

// ----- Campaigns -----
app.post("/api/campaigns/import", upload.single("file"), async (req, res) => {
  try {
    const bodySchema = z.object({
      clientId: z.string().min(1),
      campaignName: z.string().min(1),
      phoneColumn: z.string().default("phone"),
      nameColumn: z.string().default("name"),
    });
    const body = bodySchema.parse(req.body);
    if (!req.file) return res.status(400).json({ error: "file required" });

    const contacts = parseContactsFromSheet(req.file.path, body.phoneColumn, body.nameColumn);
    safeRemoveFile(req.file.path);

    const db = getDb();
    const campaignId = uuidv4();
    await db.collection(COLLECTIONS.CAMPAIGNS).insertOne({
      id: campaignId,
      client_id: body.clientId,
      name: body.campaignName,
      status: "draft",
      created_at: nowIso(),
    });

    const contactDocs = contacts.map((c) => ({
      id: uuidv4(),
      campaign_id: campaignId,
      name: c.name || null,
      phone: c.phone,
      metadata: c.metadata,
      status: "pending",
    }));

    if (contactDocs.length > 0) {
      await db.collection(COLLECTIONS.CONTACTS).insertMany(contactDocs);
    }

    res.status(201).json({ campaignId, contactCount: contacts.length });
  } catch (err) {
    if (req.file?.path) safeRemoveFile(req.file.path);
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/campaigns/:campaignId/start", async (req, res) => {
  try {
    const db = getDb();
    const campaign = await db.collection(COLLECTIONS.CAMPAIGNS).findOne({ id: req.params.campaignId });
    if (!campaign) return res.status(404).json({ error: "Campaign not found" });

    const contacts = await db.collection(COLLECTIONS.CONTACTS).find({ campaign_id: req.params.campaignId, status: "pending" }).toArray();
    // Force strict one-by-one dispatch to avoid provider subscription/concurrency limits.
    const concurrency = 1;

    await db.collection(COLLECTIONS.CAMPAIGNS).updateOne(
      { id: req.params.campaignId },
      { $set: { status: "running" } }
    );

    const results = [];
    let index = 0;

    async function worker() {
      while (index < contacts.length) {
        const c = contacts[index++];
        try {
          await enqueueCall({
            clientId: campaign.client_id,
            campaignId: campaign.id,
            contactId: c.id,
            phone: c.phone,
            name: c.name ?? undefined,
            metadata: c.metadata ?? {},
          });
          await db.collection(COLLECTIONS.CONTACTS).updateOne({ id: c.id }, { $set: { status: "dispatched" } });
          results.push({ contactId: c.id, ok: true });
        } catch (err) {
          await db.collection(COLLECTIONS.CONTACTS).updateOne({ id: c.id }, { $set: { status: "failed" } });
          results.push({ contactId: c.id, ok: false, error: err.message });
        }
      }
    }

    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    await db.collection(COLLECTIONS.CAMPAIGNS).updateOne(
      { id: req.params.campaignId },
      { $set: { status: "dispatched" } }
    );

    res.json({
      campaignId: req.params.campaignId,
      dispatched: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/campaigns", async (req, res) => {
  const db = getDb();
  const clientId = req.query.clientId;
  const filter = clientId ? { client_id: clientId } : {};
  const items = await db.collection(COLLECTIONS.CAMPAIGNS).find(filter).sort({ created_at: -1 }).limit(100).toArray();
  res.json({ items });
});

// ----- Playground: token for testing -----
app.post("/api/playground/token", async (req, res) => {
  try {
    const { AccessToken } = await import("livekit-server-sdk");
    const { env } = await import("./config.js");
    const { roomName, participantName } = z.object({
      roomName: z.string().min(1),
      participantName: z.string().default("playground-user"),
    }).parse(req.body);

    const token = new AccessToken(
      env.LIVEKIT_API_KEY,
      env.LIVEKIT_API_SECRET,
      { identity: participantName, name: participantName }
    );
    token.addGrant({ roomJoin: true, room: roomName });

    res.json({ token: await token.toJwt(), roomName });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

export default app;

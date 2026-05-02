import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { getDb, COLLECTIONS } from "./db.js";
import { createDispatch, cancelDispatch } from "./livekit.js";
import { env } from "./config.js";
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

function b64url(input) {
  return Buffer.from(input).toString("base64url");
}

function fromB64url(input) {
  return Buffer.from(input, "base64url").toString("utf8");
}

function getJoinTokenSecret() {
  return env.INTERVIEW_JOIN_TOKEN_SECRET || env.LIVEKIT_API_SECRET;
}

function signInterviewJoinToken(payload) {
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = b64url(JSON.stringify(header));
  const encodedPayload = b64url(JSON.stringify(payload));
  const unsigned = `${encodedHeader}.${encodedPayload}`;
  const sig = crypto.createHmac("sha256", getJoinTokenSecret()).update(unsigned).digest("base64url");
  return `${unsigned}.${sig}`;
}

function verifyInterviewJoinToken(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new Error("Invalid join token format");
  const [encodedHeader, encodedPayload, sig] = parts;
  const unsigned = `${encodedHeader}.${encodedPayload}`;
  const expected = crypto.createHmac("sha256", getJoinTokenSecret()).update(unsigned).digest("base64url");
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    throw new Error("Invalid join token signature");
  }
  const payload = JSON.parse(fromB64url(encodedPayload));
  if (!payload?.exp || Date.now() > payload.exp) throw new Error("Join token expired");
  return payload;
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

const StartInterviewSessionSchema = z.object({
  candidateId: z.string().min(1),
  interviewId: z.string().min(1),
  candidate: z.object({
    name: z.string().optional(),
    email: z.string().optional(),
    yearsExperience: z.coerce.number().nonnegative().optional(),
    skills: z.array(z.string()).optional(),
  }).partial().optional(),
  interviewMeta: z.object({
    title: z.string().optional(),
    /** Primary conversation language (STT/TTS bias), e.g. en */
    language: z.string().optional(),
    /** Allowed language codes for the candidate (multilingual policy), e.g. ["en","hi"] */
    languagePolicy: z.array(z.string().min(2).max(16)).optional(),
    durationMinutes: z.number().int().positive().max(180).optional(),
    mustAskTopics: z.array(z.string()).optional(),
    /** Exact interview questions the AI must ask in order */
    questions: z.array(z.string().min(1).max(4000)).optional(),
    scoringRubric: z.record(z.number()).optional(),
    customFields: z.record(z.unknown()).optional(),
    /** Optional employer-specific instructions (merged on top of agent defaults) */
    instructions: z.string().optional(),
  }).partial().optional(),
  jd: z.object({
    id: z.string().optional(),
    title: z.string().optional(),
    text: z.string().optional(),
    summary: z.string().optional(),
    url: z.string().optional(),
    version: z.string().optional(),
  }).partial().optional(),
  interviewRules: z.object({
    forbidExternalHelp: z.boolean().optional(),
    requireCameraOn: z.boolean().optional(),
    requireScreenShare: z.boolean().optional(),
    /** Legacy single string, comma-separated, or array — merged into languagePolicy */
    languagePolicy: z.union([z.string(), z.array(z.string().min(2).max(16))]).optional(),
    antiCheatLevel: z.enum(["off", "basic", "strict"]).optional(),
  }).partial().optional(),
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
  }).partial().optional(),
  vision: z.object({
    enabled: z.boolean().optional(),
    sampleEverySeconds: z.number().positive().max(120).optional(),
  }).partial().optional(),
});

const EndInterviewSessionSchema = z.object({
  reason: z.string().optional(),
});

const StandardTokenEndpointSchema = z.object({
  room_name: z.string().optional(),
  participant_identity: z.string().optional(),
  participant_name: z.string().optional(),
  participant_metadata: z.string().optional(),
  participant_attributes: z.record(z.string()).optional(),
  room_config: z.unknown().optional(),
});

const ResolveInterviewSessionSchema = z.object({
  joinToken: z.string().min(1),
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

// ----- Interview sessions (candidate video) -----
function normalizeInterviewLanguagePolicy(interviewMeta, interviewRules, primaryLanguage) {
  const primary = String(primaryLanguage || "en").trim().toLowerCase() || "en";
  const metaArr = interviewMeta?.languagePolicy;
  if (Array.isArray(metaArr) && metaArr.length > 0) {
    const out = [...new Set(metaArr.map((c) => String(c).trim().toLowerCase()).filter(Boolean))];
    if (out.length) return out;
  }
  const rulesPol = interviewRules?.languagePolicy;
  if (Array.isArray(rulesPol) && rulesPol.length > 0) {
    const out = [...new Set(rulesPol.map((c) => String(c).trim().toLowerCase()).filter(Boolean))];
    if (out.length) return out;
  }
  if (typeof rulesPol === "string" && rulesPol.trim()) {
    const out = [...new Set(
      rulesPol.split(/[,;]/).map((s) => s.trim().toLowerCase()).filter(Boolean),
    )];
    if (out.length) return out;
  }
  return [primary];
}

function normalizeInterviewQuestions(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((q) => String(q).trim()).filter((q) => q.length > 0);
}

function buildInterviewRoomName(interviewId, candidateId) {
  return `interview-${interviewId}-${candidateId}-${Date.now()}`.slice(0, 128);
}

function candidateIdentity(candidateId) {
  return `candidate_${candidateId}`;
}

app.post("/api/interviews/session/start", async (req, res) => {
  try {
    const payload = StartInterviewSessionSchema.parse(req.body);
    const db = getDb();
    const { AccessToken } = await import("livekit-server-sdk");

    const sessionId = uuidv4();
    const roomName = buildInterviewRoomName(payload.interviewId, payload.candidateId);
    const participantIdentity = candidateIdentity(payload.candidateId);
    const participantName = payload.candidate?.name || "Candidate";
    const durationMinutes = payload.interviewMeta?.durationMinutes ?? 35;
    const expiresAt = new Date(Date.now() + Math.max(5, durationMinutes + 10) * 60 * 1000);

    const token = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
      identity: participantIdentity,
      name: participantName,
      ttl: `${Math.max(5, durationMinutes + 10)}m`,
    });
    token.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true, canPublishData: true });

    const primaryLanguage = payload.interviewMeta?.language ?? "en";
    const languagePolicy = normalizeInterviewLanguagePolicy(
      payload.interviewMeta,
      payload.interviewRules,
      primaryLanguage,
    );
    const preparedQuestions = normalizeInterviewQuestions(payload.interviewMeta?.questions);
    const instructionsAdditional = (payload.interviewMeta?.instructions ?? "").trim();

    const dispatchMetadata = {
      mode: "video_interview",
      sessionId,
      interviewId: payload.interviewId,
      candidateId: payload.candidateId,
      candidateProfile: payload.candidate ?? {},
      jd: payload.jd ?? {},
      interviewRules: payload.interviewRules ?? {},
      interviewMeta: {
        title: payload.interviewMeta?.title ?? "AI Interview",
        language: primaryLanguage,
        languagePolicy,
        durationMinutes,
        mustAskTopics: payload.interviewMeta?.mustAskTopics ?? [],
        questions: preparedQuestions,
        scoringRubric: payload.interviewMeta?.scoringRubric ?? {},
        customFields: payload.interviewMeta?.customFields ?? {},
        /** Optional employer-only add-on; agent merges with built-in defaults */
        instructionsAdditional,
        /** Backward compatibility for older agents reading `instructions` */
        instructions: instructionsAdditional,
      },
      providerConfig: payload.providerConfig ?? {
        stt: { provider: "deepgram", model: "nova-3" },
        tts: { provider: "deepgram", model: "aura-asteria-en" },
      },
      vision: {
        enabled: payload.vision?.enabled ?? false,
        sampleEverySeconds: payload.vision?.sampleEverySeconds ?? 10,
      },
    };

    await db.collection(COLLECTIONS.INTERVIEW_SESSIONS).insertOne({
      session_id: sessionId,
      interview_id: payload.interviewId,
      candidate_id: payload.candidateId,
      room_name: roomName,
      participant_identity: participantIdentity,
      participant_name: participantName,
      dispatch_id: null,
      status: "waiting",
      ended_reason: null,
      metadata: dispatchMetadata,
      created_at: nowIso(),
      updated_at: nowIso(),
    });

    const joinToken = signInterviewJoinToken({
      sid: sessionId,
      cid: payload.candidateId,
      iid: payload.interviewId,
      exp: Date.now() + 45 * 60 * 1000,
      n: crypto.randomBytes(8).toString("hex"),
    });
    const candidateJoinUrl = `${env.APP_BASE_URL.replace(/\/$/, "")}/interview/join?token=${encodeURIComponent(joinToken)}`;

    res.status(201).json({
      sessionId,
      roomName,
      participantIdentity,
      participantName,
      token: await token.toJwt(),
      wsUrl: env.LIVEKIT_URL,
      expiresAt: expiresAt.toISOString(),
      candidateJoinUrl,
      joinToken,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/interviews/session/resolve", async (req, res) => {
  try {
    const { joinToken } = ResolveInterviewSessionSchema.parse(req.body ?? {});
    const decoded = verifyInterviewJoinToken(joinToken);
    const db = getDb();
    const session = await db.collection(COLLECTIONS.INTERVIEW_SESSIONS).findOne({ session_id: decoded.sid });
    if (!session) return res.status(404).json({ error: "Interview session not found" });
    if (session.candidate_id !== decoded.cid) return res.status(403).json({ error: "Candidate mismatch" });
    if (session.status === "completed") return res.status(400).json({ error: "Interview already completed" });
    if (session.status === "ended") return res.status(400).json({ error: "Interview already ended" });

    let activeSession = session;
    if (!session.dispatch_id) {
      const sid = session.session_id;
      // Only one request may move waiting → dispatching. Do not match dispatch_id:null while status is
      // already "dispatching", or concurrent resolves (e.g. React Strict Mode) both call createDispatch.
      const claim = await db.collection(COLLECTIONS.INTERVIEW_SESSIONS).updateOne(
        { session_id: sid, dispatch_id: null, status: "waiting" },
        { $set: { status: "dispatching", dispatch_requested_at: nowIso(), updated_at: nowIso() } }
      );

      if (claim.modifiedCount === 1) {
        try {
          const { dispatchId } = await createDispatch({
            roomName: session.room_name,
            callMetadata: session.metadata || {},
            agentName: env.INTERVIEW_AGENT_NAME || env.AGENT_NAME,
          });
          await db.collection(COLLECTIONS.INTERVIEW_SESSIONS).updateOne(
            { session_id: sid },
            { $set: { dispatch_id: dispatchId, status: "waiting", updated_at: nowIso() } }
          );
        } catch (dispatchErr) {
          await db.collection(COLLECTIONS.INTERVIEW_SESSIONS).updateOne(
            { session_id: sid },
            { $set: { status: "waiting", updated_at: nowIso() } }
          );
          throw dispatchErr;
        }
      }

      for (let attempt = 0; attempt < 40; attempt += 1) {
        activeSession = await db.collection(COLLECTIONS.INTERVIEW_SESSIONS).findOne({ session_id: sid });
        if (activeSession?.dispatch_id) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      if (!activeSession?.dispatch_id) {
        return res.status(409).json({ error: "Agent is being prepared. Please retry in a moment." });
      }
    }

    const { AccessToken } = await import("livekit-server-sdk");
    const token = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
      identity: activeSession.participant_identity,
      name: activeSession.participant_name || "Candidate",
      ttl: "45m",
    });
    token.addGrant({
      roomJoin: true,
      room: activeSession.room_name,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    await db.collection(COLLECTIONS.INTERVIEW_SESSIONS).updateOne(
      { session_id: activeSession.session_id },
      { $set: { join_last_resolved_at: nowIso(), updated_at: nowIso() } }
    );

    res.json({
      sessionId: activeSession.session_id,
      roomName: activeSession.room_name,
      participantIdentity: activeSession.participant_identity,
      participantName: activeSession.participant_name,
      token: await token.toJwt(),
      wsUrl: env.LIVEKIT_URL,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/interviews/sessions", async (req, res) => {
  const db = getDb();
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.candidateId) filter.candidate_id = req.query.candidateId;
  if (req.query.interviewId) filter.interview_id = req.query.interviewId;
  const items = await db.collection(COLLECTIONS.INTERVIEW_SESSIONS)
    .find(filter)
    .sort({ created_at: -1 })
    .limit(limit)
    .toArray();
  const sessionIds = items.map((it) => it.session_id).filter(Boolean);
  const evalBySession = new Map();
  if (sessionIds.length) {
    const evals = await db.collection(COLLECTIONS.INTERVIEW_EVALUATIONS)
      .find({ session_id: { $in: sessionIds } })
      .project({ session_id: 1, overallPercent: 1, scores: 1 })
      .toArray();
    for (const ev of evals) {
      if (ev?.session_id) evalBySession.set(ev.session_id, ev);
    }
  }
  const enriched = items.map((it) => {
    const ev = evalBySession.get(it.session_id);
    const overall =
      ev?.overallPercent ??
      (typeof ev?.scores?.overall === "number" ? ev.scores.overall : null);
    return { ...it, latest_overall_score: overall ?? null };
  });
  res.json({ items: enriched });
});

app.post("/api/interviews/session/:sessionId/end", async (req, res) => {
  try {
    const { reason } = EndInterviewSessionSchema.parse(req.body ?? {});
    const db = getDb();
    const session = await db.collection(COLLECTIONS.INTERVIEW_SESSIONS).findOne({ session_id: req.params.sessionId });
    if (!session) return res.status(404).json({ error: "Interview session not found" });

    if (session.dispatch_id && ["created", "waiting", "dispatching", "in_progress"].includes(session.status)) {
      try {
        await cancelDispatch(session.dispatch_id);
      } catch {
        // best effort
      }
    }

    await db.collection(COLLECTIONS.INTERVIEW_SESSIONS).updateOne(
      { session_id: req.params.sessionId },
      { $set: { status: "ended", ended_reason: reason || "candidate_ended", updated_at: nowIso() } }
    );

    res.json({ ok: true, sessionId: req.params.sessionId });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/interviews/session/:sessionId", async (req, res) => {
  const db = getDb();
  const session = await db.collection(COLLECTIONS.INTERVIEW_SESSIONS).findOne({ session_id: req.params.sessionId });
  if (!session) return res.status(404).json({ error: "Interview session not found" });

  const events = await db.collection(COLLECTIONS.INTERVIEW_EVENTS)
    .find({ session_id: req.params.sessionId })
    .sort({ created_at: 1 })
    .toArray();
  const evaluation = await db.collection(COLLECTIONS.INTERVIEW_EVALUATIONS).findOne({ session_id: req.params.sessionId });

  res.json({ session, events, evaluation: evaluation || null });
});

app.get("/api/interviews/evaluations/:sessionId", async (req, res) => {
  const db = getDb();
  const evaluation = await db.collection(COLLECTIONS.INTERVIEW_EVALUATIONS).findOne({ session_id: req.params.sessionId });
  if (!evaluation) return res.status(404).json({ error: "Evaluation not found" });
  res.json(evaluation);
});

app.post("/api/interviews/session/:sessionId/event", async (req, res) => {
  try {
    const body = z.object({
      type: z.string().min(1),
      payload: z.record(z.unknown()).default({}),
    }).parse(req.body);

    const db = getDb();
    const session = await db.collection(COLLECTIONS.INTERVIEW_SESSIONS).findOne({ session_id: req.params.sessionId });
    if (!session) return res.status(404).json({ error: "Interview session not found" });

    await db.collection(COLLECTIONS.INTERVIEW_EVENTS).insertOne({
      id: uuidv4(),
      session_id: req.params.sessionId,
      type: body.type,
      payload: body.payload,
      created_at: nowIso(),
    });

    res.status(201).json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// LiveKit-standardized endpoint token format for frontend TokenSource.endpoint()
app.post("/api/interviews/getToken", async (req, res) => {
  try {
    const body = StandardTokenEndpointSchema.parse(req.body ?? {});
    const { AccessToken, RoomConfiguration } = await import("livekit-server-sdk");
    const roomName = body.room_name || "interview-room";
    const participantIdentity = body.participant_identity || "candidate-identity";
    const participantName = body.participant_name || "Candidate";

    const at = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
      identity: participantIdentity,
      name: participantName,
      metadata: body.participant_metadata || "",
      attributes: body.participant_attributes || {},
      ttl: "45m",
    });
    at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true, canPublishData: true });

    if (body.room_config) {
      at.roomConfig = new RoomConfiguration(body.room_config);
    }

    const participantToken = await at.toJwt();
    res.status(201).json({ server_url: env.LIVEKIT_URL, participant_token: participantToken });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
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

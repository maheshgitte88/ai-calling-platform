import express from "express";
import crypto from "node:crypto";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";

import { COLLECTIONS, getDb } from "../db.js";
import { env } from "../config.js";
import { asyncHandler } from "../lib/async-handler.js";
import { HttpError } from "../lib/http-error.js";
import { signInterviewJoinToken, verifyInterviewJoinToken } from "../lib/join-token.js";
import { nowIso } from "../lib/time.js";
import { cancelDispatch, createDispatch, stopRecordingEgress } from "../livekit/index.js";
import {
  EndInterviewSessionSchema,
  InterviewSessionEventSchema,
  ResolveInterviewSessionSchema,
  StartInterviewSessionSchema,
} from "./schemas.js";
import {
  normalizeInterviewLanguagePolicy,
  normalizeInterviewMustAskTopics,
  normalizeInterviewQuestionGroups,
  normalizeInterviewSkillSpecs,
} from "./normalize.js";
import {
  buildInterviewRoomName,
  candidateIdentity,
} from "./identifiers.js";
import {
  interviewDurationMinutesFromSession,
  linkExpiryMsFromPayload,
  ttlMinutesFromDuration,
} from "./duration.js";
import { ensureInterviewRecordingStarted, markRecordingFailed } from "./recording.js";
import { triggerSessionEvaluation } from "./evaluator-client.js";
import {
  loadInterviewSessionForJoinToken,
  PRECHECK_AUDIO_MAX_BYTES,
  validatePrecheckAudioBuffer,
} from "./precheck-helpers.js";
import {
  deleteProctorFrame,
  precheckIdentityBlobPath,
  uploadProctorFrame,
} from "../storage/proctor-frames.js";

const router = express.Router();

const SUPPORTED_PRECHECK_IMAGE_TYPES = /^image\/(jpe?g|png|webp)$/i;

const precheckAudioMulter = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: PRECHECK_AUDIO_MAX_BYTES },
});

const precheckIdentityMulter = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024 },
});

// ---------------------------------------------------------------------------
// Helpers (private to the routes module)
// ---------------------------------------------------------------------------

const DISPATCH_POLL_ATTEMPTS = 40;
const DISPATCH_POLL_INTERVAL_MS = 250;
const AGENT_READY_POLL_ATTEMPTS = 30;
const AGENT_READY_POLL_INTERVAL_MS = 500;
const STALE_DISPATCH_RETRY_MS = 90 * 1000;

async function loadAccessToken() {
  // Imported dynamically to keep the cold-start cost out of `livekit/clients`.
  const { AccessToken } = await import("livekit-server-sdk");
  return AccessToken;
}

function buildDispatchMetadata(payload, sessionId) {
  const primaryLanguage = payload.interviewMeta?.language ?? "en";
  const languagePolicy = normalizeInterviewLanguagePolicy(
    payload.interviewMeta,
    payload.interviewRules,
    primaryLanguage,
  );
  const questionGroups = normalizeInterviewQuestionGroups(payload.interviewMeta?.questions);
  const interviewSkills = normalizeInterviewSkillSpecs(payload.interviewMeta?.skills);
  const mustAskTopics = normalizeInterviewMustAskTopics(payload.interviewMeta?.mustAskTopics);
  const instructionsAdditional = (payload.interviewMeta?.instructions ?? "").trim();
  const durationMinutes = payload.interviewMeta?.durationMinutes ?? 35;

  return {
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
      mustAskTopics,
      // `questions` carries the structured per-skill groups now. Each group
      // has { skill, questions, askFollowUps, allowAdditional }.
      questions: questionGroups,
      skills: interviewSkills,
      scoringRubric: payload.interviewMeta?.scoringRubric ?? {},
      customFields: payload.interviewMeta?.customFields ?? {},
      /** Optional employer-only add-on; agent merges with built-in defaults */
      instructionsAdditional,
      /** Backward compatibility for older agents reading `instructions` */
      instructions: instructionsAdditional,
    },
    // Do not hard-force STT/TTS providers here. If caller does not pass providerConfig,
    // agent runtime defaults (.env / interview worker defaults) should apply.
    providerConfig: payload.providerConfig ?? {},
    vision: {
      enabled: payload.vision?.enabled ?? false,
      sampleEverySeconds: payload.vision?.sampleEverySeconds ?? 10,
    },
    recording: {
      // Default ON: recording is enabled unless the caller explicitly sends
      // `recordingEnabled: false`. Audio-only is also the default — caller
      // opts into video with `recordingAudioOnly: false`.
      enabled: payload.recordingEnabled !== false,
      layout: payload.recordingLayout || "grid",
      audioOnly: payload.recordingAudioOnly !== false,
    },
  };
}

async function claimDispatchSlot(db, sessionId) {
  return db.collection(COLLECTIONS.INTERVIEW_SESSIONS).updateOne(
    { session_id: sessionId, dispatch_id: null, status: "waiting" },
    {
      $set: {
        status: "dispatching",
        agent_status: "dispatching",
        agent_error: null,
        agent_ready_at: null,
        agent_failed_at: null,
        dispatch_requested_at: nowIso(),
        updated_at: nowIso(),
      },
    },
  );
}

async function attachDispatchToSession(db, sessionId, session) {
  const { dispatchId } = await createDispatch({
    roomName: session.room_name,
    metadata: session.metadata || {},
    agentName: env.INTERVIEW_AGENT_NAME || env.AGENT_NAME,
  });
  await db.collection(COLLECTIONS.INTERVIEW_SESSIONS).updateOne(
    { session_id: sessionId },
    {
      $set: {
        dispatch_id: dispatchId,
        status: "waiting",
        agent_status: "dispatching",
        dispatch_created_at: nowIso(),
        updated_at: nowIso(),
      },
    },
  );
}

async function pollSessionUntilDispatched(db, sessionId) {
  let session = null;
  for (let attempt = 0; attempt < DISPATCH_POLL_ATTEMPTS; attempt += 1) {
    session = await db.collection(COLLECTIONS.INTERVIEW_SESSIONS).findOne({ session_id: sessionId });
    if (session?.dispatch_id) return session;
    await new Promise((r) => setTimeout(r, DISPATCH_POLL_INTERVAL_MS));
  }
  return session;
}

function isAgentReadyForJoin(session) {
  if (!session) return false;
  if (session.started_at) return true;
  if (session.agent_status === "ready") return true;
  return ["in_progress", "wrap_up", "completed"].includes(session.status);
}

function shouldRecoverDispatch(session) {
  if (!session?.dispatch_id || session?.started_at) return false;
  if (session?.agent_status === "failed") return true;
  const requestedAtMs = Date.parse(session?.dispatch_requested_at || "");
  if (!Number.isFinite(requestedAtMs)) return false;
  return Date.now() - requestedAtMs >= STALE_DISPATCH_RETRY_MS;
}

async function pollSessionUntilAgentReady(db, sessionId) {
  let session = null;
  for (let attempt = 0; attempt < AGENT_READY_POLL_ATTEMPTS; attempt += 1) {
    session = await db.collection(COLLECTIONS.INTERVIEW_SESSIONS).findOne({ session_id: sessionId });
    if (isAgentReadyForJoin(session)) return session;
    await new Promise((r) => setTimeout(r, AGENT_READY_POLL_INTERVAL_MS));
  }
  return session;
}

async function resetDispatchForRetry(db, session, reason) {
  if (session?.dispatch_id) {
    try {
      await cancelDispatch(session.dispatch_id);
    } catch {
      // best effort
    }
  }
  await db.collection(COLLECTIONS.INTERVIEW_SESSIONS).updateOne(
    { session_id: session.session_id },
    {
      $set: {
        dispatch_id: null,
        status: "waiting",
        agent_status: "dispatch_pending",
        agent_ready_at: null,
        agent_failed_at: null,
        agent_error: reason || null,
        dispatch_requested_at: null,
        dispatch_created_at: null,
        updated_at: nowIso(),
      },
    },
  );
}

async function issueParticipantToken(session) {
  const AccessToken = await loadAccessToken();
  const ttlMinutes = ttlMinutesFromDuration(interviewDurationMinutesFromSession(session));
  const token = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
    identity: session.participant_identity,
    name: session.participant_name || "Candidate",
    ttl: `${ttlMinutes}m`,
  });
  token.addGrant({
    roomJoin: true,
    room: session.room_name,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });
  return token;
}

function isCancellableDispatchStatus(status) {
  return ["created", "waiting", "dispatching", "in_progress"].includes(status);
}

// ---------------------------------------------------------------------------
// POST /api/interviews/session/start
// ---------------------------------------------------------------------------

router.post(
  "/session/start",
  asyncHandler(async (req, res) => {
    const payload = StartInterviewSessionSchema.parse(req.body);
    const db = getDb();

    const sessionId = uuidv4();
    const roomName = buildInterviewRoomName(payload.interviewId, payload.candidateId);
    const participantIdentity = candidateIdentity(payload.candidateId);
    const participantName = payload.candidate?.name || "Candidate";
    const durationMinutes = payload.interviewMeta?.durationMinutes ?? 35;
    const tokenTtlMinutes = ttlMinutesFromDuration(durationMinutes);
    const expiresAt = new Date(Date.now() + tokenTtlMinutes * 60 * 1000);

    const AccessToken = await loadAccessToken();
    const token = new AccessToken(env.LIVEKIT_API_KEY, env.LIVEKIT_API_SECRET, {
      identity: participantIdentity,
      name: participantName,
      ttl: `${tokenTtlMinutes}m`,
    });
    token.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    const dispatchMetadata = buildDispatchMetadata(payload, sessionId);

    await db.collection(COLLECTIONS.INTERVIEW_SESSIONS).insertOne({
      session_id: sessionId,
      interview_id: payload.interviewId,
      candidate_id: payload.candidateId,
      room_name: roomName,
      participant_identity: participantIdentity,
      participant_name: participantName,
      dispatch_id: null,
      dispatch_requested_at: null,
      dispatch_created_at: null,
      agent_status: "dispatch_pending",
      agent_ready_at: null,
      agent_failed_at: null,
      agent_error: null,
      egress_id: null,
      recording_status: dispatchMetadata.recording.enabled ? "pending" : "disabled",
      status: "waiting",
      ended_reason: null,
      metadata: dispatchMetadata,
      created_at: nowIso(),
      updated_at: nowIso(),
    });

    const linkExpiryMs = linkExpiryMsFromPayload(payload);
    const joinToken = signInterviewJoinToken({
      sid: sessionId,
      cid: payload.candidateId,
      iid: payload.interviewId,
      exp: Date.now() + linkExpiryMs,
      n: crypto.randomBytes(8).toString("hex"),
    });
    const linkExpiresAt = new Date(Date.now() + linkExpiryMs);
    const candidateJoinUrl = `${env.APP_BASE_URL.replace(/\/$/, "")}/interview/join?token=${encodeURIComponent(joinToken)}`;

    res.status(201).json({
      sessionId,
      roomName,
      participantIdentity,
      participantName,
      token: await token.toJwt(),
      wsUrl: env.LIVEKIT_PUBLIC_URL,
      expiresAt: expiresAt.toISOString(),
      linkExpiresAt: linkExpiresAt.toISOString(),
      candidateJoinUrl,
      joinToken,
    });
  }),
);

// ---------------------------------------------------------------------------
// POST /api/interviews/session/precheck/meta
// ---------------------------------------------------------------------------

router.post(
  "/session/precheck/meta",
  asyncHandler(async (req, res) => {
    const { joinToken } = ResolveInterviewSessionSchema.parse(req.body ?? {});
    const db = getDb();
    const { decoded, session } = await loadInterviewSessionForJoinToken(db, joinToken);
    const meta = session.metadata || {};
    const interviewMeta = meta.interviewMeta || {};
    const rules = meta.interviewRules;
    let rulesSummary = "";
    if (rules != null) {
      try {
        rulesSummary = JSON.stringify(rules);
        if (rulesSummary.length > 2000) {
          rulesSummary = `${rulesSummary.slice(0, 2000)}…`;
        }
      } catch {
        rulesSummary = "";
      }
    }
    res.json({
      sessionId: session.session_id,
      participantName: session.participant_name || "Candidate",
      interviewTitle: interviewMeta.title ?? "AI Interview",
      instructions: String(interviewMeta.instructions || "").trim(),
      rulesSummary,
      linkExpiresAt: new Date(decoded.exp).toISOString(),
    });
  }),
);

// ---------------------------------------------------------------------------
// POST /api/interviews/session/precheck/audio
// ---------------------------------------------------------------------------

router.post(
  "/session/precheck/audio",
  precheckAudioMulter.single("audio"),
  asyncHandler(async (req, res) => {
    const joinToken = String(req.body?.joinToken || "");
    if (!joinToken) throw new HttpError(400, "Missing joinToken");
    const db = getDb();
    const { session } = await loadInterviewSessionForJoinToken(db, joinToken);
    const file = req.file;
    if (!file?.buffer?.length) throw new HttpError(400, "Missing audio file");

    const checks = validatePrecheckAudioBuffer(file.buffer, file.mimetype || "");

    try {
      await db.collection(COLLECTIONS.INTERVIEW_EVENTS).insertOne({
        id: uuidv4(),
        session_id: session.session_id,
        type: "precheck_audio_ok",
        payload: {
          at: nowIso(),
          bytes: checks.bytes,
          container: checks.container,
          variance: Math.round(checks.variance * 1000) / 1000,
        },
        created_at: nowIso(),
      });
    } catch {
      /* best-effort audit only */
    }

    res.json({
      ok: true,
      checks: {
        bytes: checks.bytes,
        container: checks.container,
        variance: Math.round(checks.variance * 1000) / 1000,
      },
    });
  }),
);

// ---------------------------------------------------------------------------
// POST /api/interviews/session/precheck/identity
// ---------------------------------------------------------------------------

router.post(
  "/session/precheck/identity",
  precheckIdentityMulter.single("image"),
  asyncHandler(async (req, res) => {
    const joinToken = String(req.body?.joinToken || "");
    if (!joinToken) throw new HttpError(400, "Missing joinToken");
    const db = getDb();
    const { session } = await loadInterviewSessionForJoinToken(db, joinToken);
    const file = req.file;
    if (!file?.buffer?.length) throw new HttpError(400, "Missing image file");
    if (!SUPPORTED_PRECHECK_IMAGE_TYPES.test(file.mimetype || "")) {
      throw new HttpError(400, "Unsupported image content type");
    }
    let metaPayload = {};
    if (req.body?.meta) {
      try {
        metaPayload = JSON.parse(req.body.meta);
      } catch {
        throw new HttpError(400, "Invalid meta JSON");
      }
    }

    const capturedAt = nowIso();
    const blobPath = precheckIdentityBlobPath(session, capturedAt);
    const previousIdentityDocs = await db
      .collection(COLLECTIONS.INTERVIEW_PROCTOR_FRAMES)
      .find({
        session_id: session.session_id,
        $or: [
          { frame_kind: "precheck_identity" },
          { "client_meta.kind": "precheck_identity" },
          { "client_meta.frameKind": "precheck_identity" },
        ],
      })
      .project({ _id: 1, blob_path: 1 })
      .toArray();

    let uploadResult;
    try {
      uploadResult = await uploadProctorFrame({
        buffer: file.buffer,
        blobPath,
        contentType: file.mimetype,
        metadata: {
          session_id: session.session_id,
          interview_id: session.interview_id || "",
          candidate_id: session.candidate_id || "",
          captured_at: capturedAt,
          precheck: "true",
        },
      });
    } catch (uploadErr) {
      console.error(
        "[precheck] identity upload failed",
        JSON.stringify({
          sessionId: session.session_id,
          message: uploadErr?.message || String(uploadErr),
        }),
      );
      throw new HttpError(502, "Failed to persist precheck image");
    }

    const doc = {
      id: uuidv4(),
      session_id: session.session_id,
      interview_id: session.interview_id || null,
      candidate_id: session.candidate_id || null,
      captured_at: capturedAt,
      blob_path: uploadResult.blobPath,
      blob_url: uploadResult.url,
      container: uploadResult.container,
      size_bytes: uploadResult.sizeBytes,
      content_type: file.mimetype,
      frame_kind: "precheck_identity",
      client_meta: { ...metaPayload, precheck: true, kind: "precheck_identity", frameKind: "precheck_identity" },
      analysis_status: "pending",
      created_at: nowIso(),
    };

    await db.collection(COLLECTIONS.INTERVIEW_PROCTOR_FRAMES).insertOne(doc);
    if (previousIdentityDocs.length) {
      for (const previous of previousIdentityDocs) {
        try {
          await deleteProctorFrame(previous.blob_path);
        } catch (deleteErr) {
          console.warn(
            "[precheck] previous identity blob delete failed",
            JSON.stringify({
              sessionId: session.session_id,
              blobPath: previous.blob_path,
              message: deleteErr?.message || String(deleteErr),
            }),
          );
        }
      }
      await db.collection(COLLECTIONS.INTERVIEW_PROCTOR_FRAMES).deleteMany({
        _id: { $in: previousIdentityDocs.map((item) => item._id) },
      });
    }

    res.status(201).json({
      ok: true,
      frameId: doc.id,
      blobPath: uploadResult.blobPath,
      url: uploadResult.url,
      capturedAt,
    });
  }),
);

// ---------------------------------------------------------------------------
// POST /api/interviews/session/resolve
// ---------------------------------------------------------------------------

router.post(
  "/session/resolve",
  asyncHandler(async (req, res) => {
    const { joinToken } = ResolveInterviewSessionSchema.parse(req.body ?? {});
    const decoded = verifyInterviewJoinToken(joinToken);
    const db = getDb();

    const session = await db
      .collection(COLLECTIONS.INTERVIEW_SESSIONS)
      .findOne({ session_id: decoded.sid });
    if (!session) throw new HttpError(404, "Interview session not found");
    if (session.candidate_id !== decoded.cid) throw new HttpError(403, "Candidate mismatch");
    if (session.status === "completed") throw new HttpError(400, "Interview already completed");
    if (session.status === "ended") throw new HttpError(400, "Interview already ended");

    let activeSession = session;
    if (shouldRecoverDispatch(activeSession)) {
      await resetDispatchForRetry(db, activeSession, "stale_or_failed_dispatch");
      activeSession = await db
        .collection(COLLECTIONS.INTERVIEW_SESSIONS)
        .findOne({ session_id: activeSession.session_id });
    }

    if (!activeSession.dispatch_id) {
      const sid = session.session_id;
      // Only one request may move waiting → dispatching. Concurrent resolves
      // (e.g. React Strict Mode) would otherwise both call createDispatch.
      const claim = await claimDispatchSlot(db, sid);

      if (claim.modifiedCount === 1) {
        try {
          await attachDispatchToSession(db, sid, activeSession);
        } catch (dispatchErr) {
          await db.collection(COLLECTIONS.INTERVIEW_SESSIONS).updateOne(
            { session_id: sid },
            {
              $set: {
                status: "waiting",
                agent_status: "dispatch_pending",
                agent_error: String(dispatchErr?.message || dispatchErr || "dispatch_create_failed"),
                updated_at: nowIso(),
              },
            },
          );
          throw dispatchErr;
        }
      }

      activeSession = await pollSessionUntilDispatched(db, sid);
      if (!activeSession?.dispatch_id) {
        throw new HttpError(409, "AI interviewer is being prepared. Please retry in a moment.");
      }
    }

    activeSession = await pollSessionUntilAgentReady(db, activeSession.session_id);
    if (!isAgentReadyForJoin(activeSession)) {
      if (shouldRecoverDispatch(activeSession)) {
        await resetDispatchForRetry(db, activeSession, "agent_not_ready_timeout");
      }
      throw new HttpError(409, "AI interviewer is still joining. Please wait a few seconds and retry.");
    }

    const token = await issueParticipantToken(activeSession);

    await db.collection(COLLECTIONS.INTERVIEW_SESSIONS).updateOne(
      { session_id: activeSession.session_id },
      { $set: { join_last_resolved_at: nowIso(), updated_at: nowIso() } },
    );

    // Fallback start: recording is enabled but candidate_connected hasn't fired yet.
    try {
      await ensureInterviewRecordingStarted(db, activeSession);
    } catch (recErr) {
      console.error(
        "[recording] resolve-trigger start failed",
        JSON.stringify({
          sessionId: activeSession.session_id,
          message: recErr?.message || String(recErr),
        }),
      );
      await markRecordingFailed(db, activeSession.session_id, recErr);
    }

    res.json({
      sessionId: activeSession.session_id,
      roomName: activeSession.room_name,
      participantIdentity: activeSession.participant_identity,
      participantName: activeSession.participant_name,
      token: await token.toJwt(),
      wsUrl: env.LIVEKIT_PUBLIC_URL,
    });
  }),
);

// ---------------------------------------------------------------------------
// GET /api/interviews/sessions  (list with latest evaluation overall %)
// ---------------------------------------------------------------------------

router.get(
  "/sessions",
  asyncHandler(async (req, res) => {
    const db = getDb();
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.candidateId) filter.candidate_id = req.query.candidateId;
    if (req.query.interviewId) filter.interview_id = req.query.interviewId;

    const items = await db
      .collection(COLLECTIONS.INTERVIEW_SESSIONS)
      .find(filter)
      .sort({ created_at: -1 })
      .limit(limit)
      .toArray();

    const sessionIds = items.map((it) => it.session_id).filter(Boolean);
    const evalBySession = new Map();
    if (sessionIds.length) {
      const evals = await db
        .collection(COLLECTIONS.INTERVIEW_EVALUATIONS)
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
  }),
);

// ---------------------------------------------------------------------------
// POST /api/interviews/session/:sessionId/end
// ---------------------------------------------------------------------------

router.post(
  "/session/:sessionId/end",
  asyncHandler(async (req, res) => {
    const { reason } = EndInterviewSessionSchema.parse(req.body ?? {});
    const db = getDb();
    const session = await db
      .collection(COLLECTIONS.INTERVIEW_SESSIONS)
      .findOne({ session_id: req.params.sessionId });
    if (!session) throw new HttpError(404, "Interview session not found");

    // Only cancel the agent dispatch when the candidate never actually joined
    // the room (no `started_at`). Once the interview has started, the
    // candidate's room disconnect is what naturally ends `_drive_interview()`
    // in the agent — and the agent then runs and persists the evaluation.
    // Cancelling the dispatch here would race the agent and risk killing it
    // mid-evaluation, leaving a transcript without a summary in MongoDB.
    const candidateNeverJoined = !session.started_at;
    if (
      candidateNeverJoined
      && session.dispatch_id
      && isCancellableDispatchStatus(session.status)
    ) {
      try {
        await cancelDispatch(session.dispatch_id);
      } catch {
        // best effort
      }
    }

    if (session.egress_id) {
      try {
        await stopRecordingEgress(session.egress_id);
      } catch {
        // best effort
      }
    }

    await db.collection(COLLECTIONS.INTERVIEW_SESSIONS).updateOne(
      { session_id: req.params.sessionId },
      {
        $set: {
          status: "ended",
          ended_reason: reason || "candidate_ended",
          recording_status: session.egress_id ? "ended" : session.recording_status || "disabled",
          recording_ended_at: session.egress_id ? nowIso() : session.recording_ended_at || null,
          updated_at: nowIso(),
        },
      },
    );

    res.json({ ok: true, sessionId: req.params.sessionId });
  }),
);

// ---------------------------------------------------------------------------
// POST /api/interviews/session/:sessionId/evaluate
// Manual / fallback summary generation. Reads the persisted transcript from
// MongoDB and runs the same evaluation pipeline as the live agent. Useful
// when the agent died before persisting the evaluation, or when a recruiter
// wants to regenerate a summary.
// ---------------------------------------------------------------------------

router.post(
  "/session/:sessionId/evaluate",
  asyncHandler(async (req, res) => {
    const sessionId = req.params.sessionId;
    const db = getDb();

    const session = await db
      .collection(COLLECTIONS.INTERVIEW_SESSIONS)
      .findOne({ session_id: sessionId });
    if (!session) throw new HttpError(404, "Interview session not found");

    const transcriptCount = await db
      .collection(COLLECTIONS.INTERVIEW_EVENTS)
      .countDocuments({ session_id: sessionId, type: "transcript" });
    if (transcriptCount === 0) {
      throw new HttpError(409, "No transcript available for this session");
    }

    console.info(
      "[evaluator] manual evaluation requested",
      JSON.stringify({ sessionId, transcriptCount }),
    );

    const result = await triggerSessionEvaluation(sessionId);

    res.json({ ok: true, sessionId, ...result });
  }),
);

function buildProctorArtifactsSummary(session, frames, events) {
  const frameCounts = {};
  for (const frame of frames) {
    const kind = frame.frame_kind || "unknown";
    frameCounts[kind] = (frameCounts[kind] || 0) + 1;
  }
  const precheckAudio = (events || [])
    .filter((e) => e?.type === "precheck_audio_ok")
    .map((e) => ({
      at: e.payload?.at || e.created_at,
      bytes: e.payload?.bytes ?? null,
      container: e.payload?.container ?? null,
      variance: e.payload?.variance ?? null,
    }));
  const identityFrames = frames.filter((f) => f.frame_kind === "precheck_identity");
  const tabSwitchFrames = frames.filter((f) => f.frame_kind === "tab_switch");
  const cameraFrames = frames.filter((f) => f.frame_kind === "camera_interval");

  return {
    totalFrames: frames.length,
    frameCounts,
    latestFlags: session?.proctor_latest_flags || null,
    sessionCounts: {
      tabSwitchCount: Number(session?.proctor_tab_switch_count) || 0,
      notFrontalSeconds: Number(session?.proctor_not_frontal_seconds) || 0,
      eyeMovementCount: Number(session?.proctor_eye_movement_count) || 0,
    },
    precheckAudio,
    identitySnapshot: identityFrames.length ? identityFrames[identityFrames.length - 1] : null,
    frames: frames.map((f) => ({
      id: f.id,
      frame_kind: f.frame_kind,
      captured_at: f.captured_at,
      created_at: f.created_at,
      blob_url: f.blob_url,
      blob_path: f.blob_path,
      size_bytes: f.size_bytes,
      content_type: f.content_type,
      client_meta: f.client_meta || null,
    })),
    tabSwitchSnapshots: tabSwitchFrames.slice(-12),
    cameraSnapshots: cameraFrames.slice(-8),
  };
}

// ---------------------------------------------------------------------------
// GET /api/interviews/session/:sessionId
// ---------------------------------------------------------------------------

router.get(
  "/session/:sessionId",
  asyncHandler(async (req, res) => {
    const db = getDb();
    const session = await db
      .collection(COLLECTIONS.INTERVIEW_SESSIONS)
      .findOne({ session_id: req.params.sessionId });
    if (!session) throw new HttpError(404, "Interview session not found");

    const includeEvents = req.query.includeEvents !== "false";
    const includeProctor = req.query.includeProctor === "true";
    const events = includeEvents
      ? await db
        .collection(COLLECTIONS.INTERVIEW_EVENTS)
        .find({ session_id: req.params.sessionId })
        .sort({ created_at: 1 })
        .toArray()
      : [];
    const evaluation = await db
      .collection(COLLECTIONS.INTERVIEW_EVALUATIONS)
      .findOne({ session_id: req.params.sessionId });

    let proctorArtifacts = null;
    if (includeProctor) {
      const frames = await db
        .collection(COLLECTIONS.INTERVIEW_PROCTOR_FRAMES)
        .find({ session_id: req.params.sessionId })
        .sort({ captured_at: 1 })
        .toArray();
      proctorArtifacts = buildProctorArtifactsSummary(session, frames, events);
    }

    res.json({ session, events, evaluation: evaluation || null, proctorArtifacts });
  }),
);

// ---------------------------------------------------------------------------
// GET /api/interviews/evaluations/:sessionId
// ---------------------------------------------------------------------------

router.get(
  "/evaluations/:sessionId",
  asyncHandler(async (req, res) => {
    const db = getDb();
    const evaluation = await db
      .collection(COLLECTIONS.INTERVIEW_EVALUATIONS)
      .findOne({ session_id: req.params.sessionId });
    if (!evaluation) throw new HttpError(404, "Evaluation not found");
    res.json(evaluation);
  }),
);

// ---------------------------------------------------------------------------
// POST /api/interviews/session/:sessionId/event
// ---------------------------------------------------------------------------

router.post(
  "/session/:sessionId/event",
  asyncHandler(async (req, res) => {
    const body = InterviewSessionEventSchema.parse(req.body);
    const db = getDb();
    const session = await db
      .collection(COLLECTIONS.INTERVIEW_SESSIONS)
      .findOne({ session_id: req.params.sessionId });
    if (!session) throw new HttpError(404, "Interview session not found");

    await db.collection(COLLECTIONS.INTERVIEW_EVENTS).insertOne({
      id: uuidv4(),
      session_id: req.params.sessionId,
      type: body.type,
      payload: body.payload,
      created_at: nowIso(),
    });

    if (body.type === "candidate_connected") {
      await db.collection(COLLECTIONS.INTERVIEW_SESSIONS).updateOne(
        { session_id: req.params.sessionId, started_at: { $exists: false } },
        { $set: { started_at: nowIso(), updated_at: nowIso() } },
      );
      await db.collection(COLLECTIONS.INTERVIEW_SESSIONS).updateOne(
        { session_id: req.params.sessionId },
        {
          $set: {
            candidate_connection_status: "connected",
            last_candidate_connected_at: nowIso(),
            reconnect_grace_started_at: null,
            reconnect_grace_ends_at: null,
            updated_at: nowIso(),
          }
        },
      );
      try {
        await ensureInterviewRecordingStarted(db, session);
      } catch (recErr) {
        console.error(
          "[recording] candidate_connected start failed",
          JSON.stringify({
            sessionId: req.params.sessionId,
            message: recErr?.message || String(recErr),
          }),
        );
        await markRecordingFailed(db, req.params.sessionId, recErr);
      }
    }

    if (body.type === "candidate_reconnected") {
      await db.collection(COLLECTIONS.INTERVIEW_SESSIONS).updateOne(
        { session_id: req.params.sessionId },
        {
          $set: {
            candidate_connection_status: "connected",
            last_candidate_connected_at: nowIso(),
            reconnect_grace_started_at: null,
            reconnect_grace_ends_at: null,
            updated_at: nowIso(),
          }
        },
      );
    }

    if (body.type === "candidate_disconnected") {
      await db.collection(COLLECTIONS.INTERVIEW_SESSIONS).updateOne(
        { session_id: req.params.sessionId },
        {
          $set: {
            candidate_connection_status: "disconnected",
            last_candidate_disconnected_at: nowIso(),
            updated_at: nowIso(),
          }
        },
      );
    }

    res.status(201).json({ ok: true });
  }),
);

export default router;

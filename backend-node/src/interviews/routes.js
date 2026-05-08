import express from "express";
import crypto from "node:crypto";
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

const router = express.Router();

// ---------------------------------------------------------------------------
// Helpers (private to the routes module)
// ---------------------------------------------------------------------------

const DISPATCH_POLL_ATTEMPTS = 40;
const DISPATCH_POLL_INTERVAL_MS = 250;

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
      enabled: Boolean(payload.recordingEnabled),
      layout: payload.recordingLayout || "grid",
      // Default to audio-only recording. Caller can opt into video by
      // explicitly sending `recordingAudioOnly: false` in the payload.
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
    { $set: { dispatch_id: dispatchId, status: "waiting", updated_at: nowIso() } },
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
    if (!session.dispatch_id) {
      const sid = session.session_id;
      // Only one request may move waiting → dispatching. Concurrent resolves
      // (e.g. React Strict Mode) would otherwise both call createDispatch.
      const claim = await claimDispatchSlot(db, sid);

      if (claim.modifiedCount === 1) {
        try {
          await attachDispatchToSession(db, sid, session);
        } catch (dispatchErr) {
          await db.collection(COLLECTIONS.INTERVIEW_SESSIONS).updateOne(
            { session_id: sid },
            { $set: { status: "waiting", updated_at: nowIso() } },
          );
          throw dispatchErr;
        }
      }

      activeSession = await pollSessionUntilDispatched(db, sid);
      if (!activeSession?.dispatch_id) {
        throw new HttpError(409, "Agent is being prepared. Please retry in a moment.");
      }
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

    if (session.dispatch_id && isCancellableDispatchStatus(session.status)) {
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

    const events = await db
      .collection(COLLECTIONS.INTERVIEW_EVENTS)
      .find({ session_id: req.params.sessionId })
      .sort({ created_at: 1 })
      .toArray();
    const evaluation = await db
      .collection(COLLECTIONS.INTERVIEW_EVALUATIONS)
      .findOne({ session_id: req.params.sessionId });

    res.json({ session, events, evaluation: evaluation || null });
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

    res.status(201).json({ ok: true });
  }),
);

export default router;

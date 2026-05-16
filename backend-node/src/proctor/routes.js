import express from "express";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";

import { COLLECTIONS, getDb } from "../db.js";
import { asyncHandler } from "../lib/async-handler.js";
import { HttpError } from "../lib/http-error.js";
import { nowIso } from "../lib/time.js";
import {
  proctorFrameBlobPath,
  uploadProctorFrame,
} from "../storage/proctor-frames.js";

const PROCTOR_FRAME_MAX_BYTES = 3 * 1024 * 1024;
const SUPPORTED_IMAGE_TYPES = /^image\/(jpe?g|png|webp)$/i;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: PROCTOR_FRAME_MAX_BYTES },
});

const router = express.Router();

function parseClientMeta(rawMeta) {
  if (!rawMeta) return {};
  try {
    return JSON.parse(rawMeta);
  } catch {
    throw new HttpError(400, "Invalid meta JSON");
  }
}

function clientMetaSnapshot(metaPayload) {
  const clean = {};
  for (const [key, value] of Object.entries(metaPayload || {})) {
    if (value == null) {
      clean[key] = null;
    } else if (["string", "number", "boolean"].includes(typeof value)) {
      clean[key] = value;
    }
  }
  return {
    camera_enabled: metaPayload?.cameraEnabled ?? null,
    mic_enabled: metaPayload?.micEnabled ?? null,
    screen_share_enabled: metaPayload?.screenShareEnabled ?? null,
    connection_state: metaPayload?.connectionState ?? null,
    document_visibility: metaPayload?.documentVisibility ?? null,
    window_focused: metaPayload?.windowFocused ?? null,
    width: metaPayload?.width ?? null,
    height: metaPayload?.height ?? null,
    user_agent: metaPayload?.userAgent ?? null,
    ...clean,
  };
}

function latestProctorFlags(metaPayload) {
  return {
    frame_kind: metaPayload?.frameKind || "camera_interval",
    face_present: metaPayload?.facePresent ?? null,
    face_count: metaPayload?.faceCount ?? null,
    face_orientation: metaPayload?.faceOrientation ?? null,
    frontal_ok: metaPayload?.frontalOk ?? null,
    lighting_ok: metaPayload?.lightingOk ?? null,
    eye_direction: metaPayload?.eyeDirection ?? null,
    reading_pattern_score: metaPayload?.readingPatternScore ?? null,
    reading_pattern_score_window: metaPayload?.readingPatternScoreWindow ?? null,
    reading_pattern_warning: metaPayload?.readingPatternWarning ?? null,
    reading_pattern_offscreen_seconds_window:
      metaPayload?.readingPatternOffscreenSecondsWindow ?? null,
    eye_warning: metaPayload?.eyeWarning ?? null,
    eye_sustained_direction: metaPayload?.eyeSustainedDirection ?? null,
    eye_sustained_seconds: metaPayload?.eyeSustainedSeconds ?? null,
    background_clean_score: metaPayload?.backgroundCleanScore ?? null,
    screen_capture_active: metaPayload?.screenCaptureActive ?? null,
    updated_at: nowIso(),
  };
}

router.post(
  "/session/:sessionId/proctor/frame",
  upload.single("image"),
  asyncHandler(async (req, res) => {
    const { sessionId } = req.params;
    const file = req.file;
    if (!file || !file.buffer?.length) throw new HttpError(400, "Missing image file");
    if (!SUPPORTED_IMAGE_TYPES.test(file.mimetype || "")) {
      throw new HttpError(400, "Unsupported image content type");
    }

    const metaPayload = parseClientMeta(req.body?.meta);

    const db = getDb();
    const session = await db
      .collection(COLLECTIONS.INTERVIEW_SESSIONS)
      .findOne({ session_id: sessionId });
    if (!session) throw new HttpError(404, "Interview session not found");
    if (session.status === "ended" || session.status === "completed") {
      throw new HttpError(409, "Interview session already ended");
    }

    const capturedAt = (metaPayload && metaPayload.capturedAt) || nowIso();
    const frameKind = metaPayload?.frameKind || "camera_interval";
    const blobPath = proctorFrameBlobPath(session, capturedAt);

    let uploadResult;
    try {
      uploadResult = await uploadProctorFrame({
        buffer: file.buffer,
        blobPath,
        contentType: file.mimetype,
        metadata: {
          session_id: sessionId,
          interview_id: session.interview_id || "",
          candidate_id: session.candidate_id || "",
          captured_at: capturedAt,
        },
      });
    } catch (uploadErr) {
      console.error(
        "[proctor] upload failed",
        JSON.stringify({
          sessionId,
          blobPath,
          message: uploadErr?.message || String(uploadErr),
        }),
      );
      throw new HttpError(502, "Failed to persist proctor frame");
    }

    const doc = {
      id: uuidv4(),
      session_id: sessionId,
      interview_id: session.interview_id || null,
      candidate_id: session.candidate_id || null,
      captured_at: capturedAt,
      blob_path: uploadResult.blobPath,
      blob_url: uploadResult.url,
      container: uploadResult.container,
      size_bytes: uploadResult.sizeBytes,
      content_type: file.mimetype,
      frame_kind: frameKind,
      client_meta: clientMetaSnapshot(metaPayload),
      analysis_status: "pending",
      created_at: nowIso(),
    };

    await db.collection(COLLECTIONS.INTERVIEW_PROCTOR_FRAMES).insertOne(doc);
    const sessionSet = {
      proctor_latest_frame_id: doc.id,
      proctor_latest_flags: latestProctorFlags(metaPayload),
      updated_at: nowIso(),
    };
    if (frameKind === "tab_switch") {
      sessionSet.proctor_latest_tab_switch_frame_id = doc.id;
      sessionSet.proctor_latest_tab_switch_at = capturedAt;
    }

    await db.collection(COLLECTIONS.INTERVIEW_SESSIONS).updateOne(
      { session_id: sessionId },
      {
        $set: sessionSet,
        $max: {
          proctor_tab_switch_count: Number(metaPayload?.tabSwitchCount) || 0,
          proctor_not_frontal_seconds: Number(metaPayload?.notFrontalSeconds) || 0,
          proctor_eye_movement_count: Number(metaPayload?.eyeMovementCount) || 0,
        },
      },
    );

    res.status(201).json({
      ok: true,
      frameId: doc.id,
      blobPath: uploadResult.blobPath,
      url: uploadResult.url,
      capturedAt,
    });
  }),
);

export default router;

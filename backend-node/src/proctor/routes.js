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
      client_meta: clientMetaSnapshot(metaPayload),
      analysis_status: "pending",
      created_at: nowIso(),
    };

    await db.collection(COLLECTIONS.INTERVIEW_PROCTOR_FRAMES).insertOne(doc);

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

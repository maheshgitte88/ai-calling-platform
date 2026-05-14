import { COLLECTIONS } from "../db.js";
import { HttpError } from "../lib/http-error.js";
import { verifyInterviewJoinToken } from "../lib/join-token.js";

const PRECHECK_AUDIO_MIN_BYTES = 6144;
const PRECHECK_AUDIO_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Load interview session using a signed join token (same guards as resolve).
 *
 * @param {import("mongodb").Db} db
 * @param {string} joinToken
 * @returns {Promise<{ decoded: Record<string, unknown> & { exp: number; sid: string; cid: string }; session: Record<string, unknown> }>}
 */
export async function loadInterviewSessionForJoinToken(db, joinToken) {
  let decoded;
  try {
    decoded = verifyInterviewJoinToken(joinToken);
  } catch (e) {
    throw new HttpError(400, e?.message || "Invalid join token");
  }

  const session = await db
    .collection(COLLECTIONS.INTERVIEW_SESSIONS)
    .findOne({ session_id: decoded.sid });
  if (!session) throw new HttpError(404, "Interview session not found");
  if (session.candidate_id !== decoded.cid) throw new HttpError(403, "Candidate mismatch");
  if (session.status === "completed") throw new HttpError(400, "Interview already completed");
  if (session.status === "ended") throw new HttpError(400, "Interview already ended");

  return { decoded, session };
}

function hasWebMHeader(buf) {
  return buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3;
}

function hasWavHeader(buf) {
  return (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WAVE"
  );
}

function hasOggHeader(buf) {
  return buf.length >= 4 && buf.toString("ascii", 0, 4) === "OggS";
}

/**
 * Heuristic validation: container magic, minimum size, non-trivial byte variation
 * (proxy for non-silent compressed or PCM audio).
 *
 * @param {Buffer} buffer
 * @param {string} [mimetype]
 * @returns {{ bytes: number; variance: number; container: string }}
 */
export function validatePrecheckAudioBuffer(buffer, _mimetype = "") {
  if (!buffer?.length) {
    throw new HttpError(400, "Missing audio file");
  }
  if (buffer.length < PRECHECK_AUDIO_MIN_BYTES) {
    throw new HttpError(400, "Audio clip too short or empty");
  }
  if (buffer.length > PRECHECK_AUDIO_MAX_BYTES) {
    throw new HttpError(413, "Audio clip exceeds size limit");
  }

  const container = hasWebMHeader(buffer)
    ? "webm"
    : hasWavHeader(buffer)
      ? "wav"
      : hasOggHeader(buffer)
        ? "ogg"
        : null;

  if (!container) {
    throw new HttpError(400, "Unrecognized audio container (expected WebM, WAV, or OGG)");
  }

  const step = Math.max(1, Math.floor(buffer.length / 4000));
  const samples = [];
  for (let i = 0; i < buffer.length; i += step) {
    samples.push(buffer[i]);
  }
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  let varSum = 0;
  for (const s of samples) {
    const d = s - mean;
    varSum += d * d;
  }
  const variance = varSum / samples.length;
  if (variance < 1.5) {
    throw new HttpError(400, "Audio appears silent or too quiet");
  }

  return { bytes: buffer.length, variance, container };
}

export { PRECHECK_AUDIO_MAX_BYTES };

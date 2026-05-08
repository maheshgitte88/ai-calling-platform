import { COLLECTIONS } from "../db.js";
import { env } from "../config.js";
import { startRoomCompositeRecording } from "../livekit/recording.js";
import { nowIso } from "../lib/time.js";
import { recordingFilepathForSession } from "./identifiers.js";

/**
 * Idempotently start the LiveKit RoomComposite egress for a session.
 *
 * Called on `candidate_connected` and as a fallback during the join-token
 * resolve path. Uses an atomic Mongo claim (`pending|failed → starting`) so
 * concurrent triggers don't double-start the egress.
 *
 * @param {import("mongodb").Db} db
 * @param {Record<string, any>} session
 * @returns {Promise<unknown | null>} The egress info, or `null` when nothing was started.
 */
export async function ensureInterviewRecordingStarted(db, session) {
  if (!session?.metadata?.recording?.enabled) return null;
  if (session?.egress_id) return null;

  const claim = await db.collection(COLLECTIONS.INTERVIEW_SESSIONS).updateOne(
    {
      session_id: session.session_id,
      egress_id: { $in: [null, undefined] },
      recording_status: { $in: ["pending", "failed"] },
    },
    { $set: { recording_status: "starting", updated_at: nowIso() } },
  );
  if (claim.modifiedCount !== 1) return null;

  console.info(
    "[recording] start claimed",
    JSON.stringify({ sessionId: session.session_id, roomName: session.room_name }),
  );

  const accountName = env.AZURE_STORAGE_ACCOUNT_NAME;
  const accountKey = env.AZURE_STORAGE_ACCOUNT_KEY;
  const containerName = env.AZURE_STORAGE_CONTAINER_NAME;
  if (!accountName || !accountKey || !containerName) {
    console.error(
      "[recording] azure env missing",
      JSON.stringify({
        sessionId: session.session_id,
        hasAccountName: Boolean(accountName),
        hasAccountKey: Boolean(accountKey),
        hasContainerName: Boolean(containerName),
      }),
    );
    throw new Error("Recording is enabled but Azure storage env is not configured.");
  }

  const filepath = recordingFilepathForSession(session);
  const info = await startRoomCompositeRecording({
    roomName: session.room_name,
    filepath,
    layout: session?.metadata?.recording?.layout || "grid",
    audioOnly: Boolean(session?.metadata?.recording?.audioOnly),
    azureAccountName: accountName,
    azureAccountKey: accountKey,
    azureContainerName: containerName,
  });

  await db.collection(COLLECTIONS.INTERVIEW_SESSIONS).updateOne(
    { session_id: session.session_id, egress_id: { $in: [null, undefined] } },
    {
      $set: {
        egress_id: info?.egressId || null,
        recording_status: "active",
        recording_started_at: nowIso(),
        recording_filepath: filepath,
        updated_at: nowIso(),
      },
    },
  );
  console.info(
    "[recording] session updated active",
    JSON.stringify({
      sessionId: session.session_id,
      egressId: info?.egressId || null,
      filepath,
    }),
  );

  return info;
}

/**
 * Mark an in-progress recording as failed and record the error message.
 * Best-effort: a Mongo failure here is logged but not re-thrown.
 */
export async function markRecordingFailed(db, sessionId, error) {
  try {
    await db.collection(COLLECTIONS.INTERVIEW_SESSIONS).updateOne(
      { session_id: sessionId },
      {
        $set: {
          recording_status: "failed",
          recording_error: error?.message || String(error),
          updated_at: nowIso(),
        },
      },
    );
  } catch (mongoErr) {
    console.error(
      "[recording] markRecordingFailed mongo update failed",
      JSON.stringify({ sessionId, message: mongoErr?.message || String(mongoErr) }),
    );
  }
}

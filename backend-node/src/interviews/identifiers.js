/**
 * Identifier and path builders for interview sessions.
 *
 * Centralised here so the recording filepath layout, candidate participant
 * identity scheme, and room-naming convention all live in one place.
 */

const MAX_ROOM_NAME_LENGTH = 128;

/** Build the LiveKit room name for an interview/candidate pair. */
export function buildInterviewRoomName(interviewId, candidateId) {
  return `interview-${interviewId}-${candidateId}-${Date.now()}`.slice(0, MAX_ROOM_NAME_LENGTH);
}

/** Build the LiveKit participant identity for a candidate. */
export function candidateIdentity(candidateId) {
  return `candidate_${candidateId}`;
}

function safeFsSegment(value, fallback) {
  return String(value || fallback).replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Build the Azure Blob filepath for a session recording.
 *
 *     interviews/<interview>/<candidate>/<session>-<timestamp>.mp4
 */
export function recordingFilepathForSession(session) {
  const interview = safeFsSegment(session?.interview_id, "interview");
  const candidate = safeFsSegment(session?.candidate_id, "candidate");
  const sessionId = session?.session_id || "session";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `interviews/${interview}/${candidate}/${sessionId}-${stamp}.mp4`;
}

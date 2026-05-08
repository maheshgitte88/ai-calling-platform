/**
 * Duration / TTL / link-expiry math for interviews.
 *
 * The constants and clamps are copied verbatim from the original `api.js`
 * to preserve client-visible behaviour (e.g. existing links must keep
 * their 24h default validity).
 */

const DEFAULT_DURATION_MINUTES = 35;
const MIN_DURATION_MINUTES = 5;
const MAX_DURATION_MINUTES = 180;

const TTL_BUFFER_MINUTES = 15;
const MIN_TTL_MINUTES = 15;
const MAX_TTL_MINUTES = 240;
const DEFAULT_TTL_MINUTES = 45;

const DEFAULT_LINK_EXPIRY_MS = 24 * 60 * 60 * 1000;

/**
 * Read the (clamped) interview duration in minutes from a stored session document.
 */
export function interviewDurationMinutesFromSession(session) {
  const raw = session?.metadata?.interviewMeta?.durationMinutes;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_DURATION_MINUTES;
  return Math.max(MIN_DURATION_MINUTES, Math.min(MAX_DURATION_MINUTES, Math.round(n)));
}

/**
 * Choose a LiveKit token TTL (in minutes) that lasts slightly longer than
 * the interview itself so the candidate doesn't get kicked at the very end.
 */
export function ttlMinutesFromDuration(durationMinutes) {
  const n = Number(durationMinutes);
  if (!Number.isFinite(n)) return DEFAULT_TTL_MINUTES;
  return Math.max(MIN_TTL_MINUTES, Math.min(MAX_TTL_MINUTES, Math.round(n + TTL_BUFFER_MINUTES)));
}

/**
 * Compute join-link validity in milliseconds from an API payload.
 *
 * Honours `linkExpiryHours` first, then `linkExpiryDays`, defaulting to
 * 24 hours. The link expiry is intentionally independent of the interview
 * duration: the candidate may follow the link any time within this window,
 * and the interview clock starts only once they actually join the room.
 */
export function linkExpiryMsFromPayload(payload) {
  const hours = Number(payload?.linkExpiryHours);
  if (Number.isFinite(hours) && hours > 0) return Math.round(hours * 60 * 60 * 1000);

  const days = Number(payload?.linkExpiryDays);
  if (Number.isFinite(days) && days > 0) return Math.round(days * 24 * 60 * 60 * 1000);

  return DEFAULT_LINK_EXPIRY_MS;
}

import crypto from "node:crypto";
import { env } from "../config.js";

/**
 * Compact JWT-style join token signed with the interview secret.
 *
 * Format: `<base64url(header)>.<base64url(payload)>.<base64url(HMAC-SHA256)>`.
 *
 * The signing secret is `INTERVIEW_JOIN_TOKEN_SECRET` when configured, else
 * the LiveKit API secret (matches the original behaviour).
 */

function b64url(input) {
  return Buffer.from(input).toString("base64url");
}

function fromB64url(input) {
  return Buffer.from(input, "base64url").toString("utf8");
}

function getJoinTokenSecret() {
  return env.INTERVIEW_JOIN_TOKEN_SECRET || env.LIVEKIT_API_SECRET;
}

/**
 * Sign a join-token payload. The caller is expected to set `exp` (ms epoch).
 *
 * @param {Record<string, unknown>} payload
 * @returns {string} Compact JWT.
 */
export function signInterviewJoinToken(payload) {
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = b64url(JSON.stringify(header));
  const encodedPayload = b64url(JSON.stringify(payload));
  const unsigned = `${encodedHeader}.${encodedPayload}`;
  const sig = crypto.createHmac("sha256", getJoinTokenSecret()).update(unsigned).digest("base64url");
  return `${unsigned}.${sig}`;
}

/**
 * Verify a previously-signed join token and return its decoded payload.
 *
 * @throws {Error} On bad format, bad signature, or expired token.
 * @param {string} token
 * @returns {Record<string, unknown> & { exp: number }}
 */
export function verifyInterviewJoinToken(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new Error("Invalid join token format");
  const [encodedHeader, encodedPayload, sig] = parts;
  const unsigned = `${encodedHeader}.${encodedPayload}`;
  const expected = crypto
    .createHmac("sha256", getJoinTokenSecret())
    .update(unsigned)
    .digest("base64url");
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    throw new Error("Invalid join token signature");
  }
  const payload = JSON.parse(fromB64url(encodedPayload));
  if (!payload?.exp || Date.now() > payload.exp) throw new Error("Join token expired");
  return payload;
}

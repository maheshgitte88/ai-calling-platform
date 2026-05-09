import { env } from "../config.js";
import { HttpError } from "../lib/http-error.js";

/**
 * Trigger the Python evaluator sidecar for a session.
 *
 * The sidecar (see `agent-python/evaluator_app.py`) loads the stored
 * transcript from MongoDB, runs the same `generate_structured_evaluation`
 * pipeline as the live agent, and upserts the result into the
 * `interview_evaluations` collection.
 *
 * @param {string} sessionId
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<any>} The evaluator's JSON response.
 */
export async function triggerSessionEvaluation(sessionId, { timeoutMs = 120_000 } = {}) {
  if (!sessionId) throw new HttpError(400, "sessionId required");

  const base = (env.INTERVIEW_EVALUATOR_URL || "").replace(/\/$/, "");
  if (!base) {
    throw new HttpError(503, "INTERVIEW_EVALUATOR_URL is not configured");
  }
  const url = `${base}/evaluate/${encodeURIComponent(sessionId)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
    });
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new HttpError(504, "Evaluator timed out");
    }
    throw new HttpError(502, `Evaluator unreachable: ${err?.message || err}`);
  } finally {
    clearTimeout(timer);
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const status = response.status >= 400 && response.status < 600 ? response.status : 502;
    const message =
      data?.message ||
      data?.error ||
      `Evaluator returned ${response.status}`;
    throw new HttpError(status, message);
  }
  return data;
}

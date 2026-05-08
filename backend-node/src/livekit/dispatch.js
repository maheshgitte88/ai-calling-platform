import { env } from "../config.js";
import { getDispatchClient } from "./clients.js";

/**
 * Create a LiveKit agent dispatch to handle an interview room.
 *
 * @param {Object} params
 * @param {string} params.roomName - LiveKit room name.
 * @param {Record<string, unknown>} [params.metadata] - Metadata passed to the agent.
 * @param {Record<string, unknown>} [params.callMetadata] - Legacy alias for `metadata`.
 * @param {string} [params.agentName] - Optional agent name override (defaults to `AGENT_NAME`).
 * @returns {Promise<{dispatchId: string}>}
 */
export async function createDispatch({ roomName, metadata, callMetadata, agentName }) {
  const client = getDispatchClient();
  const dispatch = await client.createDispatch(roomName, agentName || env.AGENT_NAME, {
    metadata: JSON.stringify(metadata || callMetadata || {}),
  });
  return { dispatchId: dispatch.id };
}

/**
 * Cancel a dispatch if still pending/active. Best-effort: silently no-ops if
 * the SDK build doesn't expose either helper.
 *
 * @param {string} dispatchId
 */
export async function cancelDispatch(dispatchId) {
  if (!dispatchId) return;
  const client = getDispatchClient();
  if (typeof client.deleteDispatch === "function") {
    await client.deleteDispatch(dispatchId);
    return;
  }
  if (typeof client.cancelDispatch === "function") {
    await client.cancelDispatch(dispatchId);
  }
}

import { AgentDispatchClient } from "livekit-server-sdk";
import { env } from "./config.js";

const dispatchClient = new AgentDispatchClient(
  env.LIVEKIT_URL,
  env.LIVEKIT_API_KEY,
  env.LIVEKIT_API_SECRET
);

/**
 * Create a LiveKit agent dispatch to handle a call.
 * @param {Object} params
 * @param {string} params.roomName - LiveKit room name
 * @param {Record<string, unknown>} params.callMetadata - Metadata passed to agent (callId, clientId, phone, etc.)
 * @param {string} [params.agentName] - Optional LiveKit agent name override
 * @returns {Promise<{dispatchId: string}>}
 */
export async function createDispatch({ roomName, callMetadata, agentName }) {
  const dispatch = await dispatchClient.createDispatch(roomName, agentName || env.AGENT_NAME, {
    metadata: JSON.stringify(callMetadata),
  });
  return { dispatchId: dispatch.id };
}

/**
 * Cancel an existing dispatch if still pending/active.
 * Best-effort; some SDK/server versions may not support cancel/delete.
 * @param {string} dispatchId
 */
export async function cancelDispatch(dispatchId) {
  if (!dispatchId) return;
  if (typeof dispatchClient.deleteDispatch === "function") {
    await dispatchClient.deleteDispatch(dispatchId);
    return;
  }
  if (typeof dispatchClient.cancelDispatch === "function") {
    await dispatchClient.cancelDispatch(dispatchId);
  }
}

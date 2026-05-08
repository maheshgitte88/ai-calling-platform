import { AgentDispatchClient, EgressClient } from "livekit-server-sdk";
import { env } from "../config.js";

/**
 * Singleton LiveKit clients.
 *
 * Both clients share the same server credentials; we expose them as
 * lazy memoized getters so unrelated code paths (and tests) don't pay
 * for them at module-load time.
 */

let _dispatchClient;
let _egressClient;

export function getDispatchClient() {
  if (!_dispatchClient) {
    _dispatchClient = new AgentDispatchClient(
      env.LIVEKIT_URL,
      env.LIVEKIT_API_KEY,
      env.LIVEKIT_API_SECRET,
    );
  }
  return _dispatchClient;
}

export function getEgressClient() {
  if (!_egressClient) {
    _egressClient = new EgressClient(
      env.LIVEKIT_URL,
      env.LIVEKIT_API_KEY,
      env.LIVEKIT_API_SECRET,
    );
  }
  return _egressClient;
}

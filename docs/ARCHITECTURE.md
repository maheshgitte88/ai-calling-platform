# AI Calling Platform - End-to-End Architecture

This document defines the production architecture for:

- high-scale AI phone calls (10,000+ concurrent sessions),
- multimodal AI interviews with post-session summaries,
- multi-tenant provider routing (LLM/STT/TTS per client),
- self-hosted LiveKit + Vobiz SIP trunking.

## 1) Core Design Principles

- Use `gemini-2.5-flash` as the default LLM everywhere (real-time and summary).
- Resolve runtime config with strict precedence:
  1. API payload override
  2. client config from MongoDB
  3. provider defaults from `.env`
- Keep summary generation async and outside the live interview media loop.
- Make provider integration pluggable: adding a provider is a metadata + factory mapping change.
- Keep tenant isolation strict: each call session resolves provider credentials from tenant scope.

## 2) Layered System

### Client Surfaces

- React dashboard: client management, prompt editor, provider config, session logs.
- Phone callers: PSTN/SIP inbound and outbound traffic.
- Interview candidates: WebRTC browser flow (camera + mic + optional screen).

### API + Control Plane

- Fast API gateway pattern with Node backend:
  - auth and tenant resolution,
  - config merge,
  - dispatch orchestration,
  - persistence and audit.
- MongoDB stores clients, configs, sessions, transcripts, summaries.

### Realtime Infrastructure

- Self-hosted LiveKit cluster:
  - room lifecycle,
  - SIP bridge + trunk integration,
  - media routing, recording, egress.
- Redis/BullMQ for async orchestration and retries.
- Kubernetes for horizontal scaling via HPA.

### Worker Plane

- Voice worker pods (Python `livekit-agents`, async): realtime phone calls.
- Interview worker pods (Python `livekit-agents`, multimodal): audio + video + prompt context.
- Summary worker pods (Python async): post-session extraction and summary writes.

### AI/Data Layer

- LLM: default `gemini-2.5-flash` (optional override by client/payload).
- STT: Deepgram/AssemblyAI/Sarvam.
- TTS: Deepgram/ElevenLabs/Cartesia/Inworld/xAI/Sarvam.
- SIP trunking via Vobiz.

## 3) Runtime Config Resolution

For each session, runtime config is resolved as:

1. Dispatch metadata override (`providerConfig`) from API request.
2. Client document in `client_configs`.
3. Environment fallback values:
   - `DEFAULT_LLM_PROVIDER`, `DEFAULT_LLM_MODEL`
   - `DEFAULT_STT_PROVIDER`, `DEFAULT_STT_MODEL`
   - `DEFAULT_TTS_PROVIDER`, `DEFAULT_TTS_MODEL`, `DEFAULT_TTS_VOICE`
   - provider API key envs (`GEMINI_API_KEY`, `DEEPGRAM_API_KEY`, etc.)

This allows:

- single-client safe defaults,
- per-client specialization,
- per-call experiments without dashboard config mutation.

## 4) Voice Call Flow (PSTN/SIP -> AI -> PSTN/SIP)

1. API creates call + LiveKit dispatch with metadata.
2. Worker resolves provider config (payload -> client -> env).
3. Worker creates LiveKit agent (`stt`, `llm`, `tts`) and joins room.
4. Worker places SIP participant via trunk (`sip_trunk_id`).
5. Conversation runs in realtime.
6. Transcript events persist incrementally.
7. On end, summary/extraction runs and updates MongoDB.

Scaling notes:

- 1 voice worker pod handles ~60-100 concurrent sessions depending on model and region.
- For ~10,000 sessions, plan roughly 120-170 pods with headroom.
- HPA metric: active rooms per pod.

## 5) Interview + Summary Pipeline

1. Candidate joins WebRTC room (video/audio).
2. Interview worker loads client prompt/model policy.
3. Multimodal LLM session runs live (audio + video + prompt context).
4. Session ends; recording + transcript egress complete.
5. Summary worker executes asynchronously (no live latency impact).
6. Structured JSON extraction persisted to summaries collection.

This separation is intentional and critical for latency stability.

## 6) Self-Hosted LiveKit Requirements

- Deploy LiveKit server and signaling/media nodes in Kubernetes.
- Enable SIP support and trunk configuration.
- Use region-local deployment to reduce RTT.
- Enable recording/egress for interview sessions per client policy.
- Turn on observability (metrics, logs, tracing) for:
  - room join delay,
  - first-token latency,
  - STT partial/final timings,
  - TTS chunk latency,
  - packet loss/jitter.

Reference: [LiveKit Overview](https://docs.livekit.io/intro/overview/)

## 7) Vobiz SIP Trunking Integration

- Create trunk in Vobiz and use its generated SIP domain credentials.
- Map trunk details into LiveKit outbound trunk (`address`, `auth_username`, `auth_password`).
- Use client-level SIP config (`provider`, `trunkId`, `fromNumber`) with env fallback trunk.
- For inbound, route Vobiz trunk destination to LiveKit SIP URI without the `sip:` prefix.

References:

- [Vobiz SIP Trunks](https://www.docs.vobiz.ai/trunks)
- [Vobiz + LiveKit Integration](https://www.docs.vobiz.ai/integrations/livekit)

## 8) Noise and Echo Cancellation

LiveKit supports audio processing paths suitable for voice AI and conferencing quality:

- acoustic echo cancellation (AEC),
- noise suppression (NS),
- automatic gain control (AGC),
- jitter buffering + packet loss concealment.

Recommended:

- enforce mono voice profile for phone calls,
- keep sample rate consistent through STT/TTS pipeline,
- monitor double-talk and far-end echo metrics,
- validate with synthetic + real-call audio QA.

## 9) Provider Extensibility Pattern

To add a new provider:

1. Add metadata in `backend-node/src/providers.js` for dashboard selection.
2. Add provider constructor in Python provider factory (`providers/llm|stt|tts`).
3. Add env key mapping in runtime resolver for secure fallback auth.
4. Add validation/default model and a quick smoke test route/call.
5. Document pricing/limits and model capabilities.

No tenant data migration is required when keeping this contract stable.

## 10) Security and Multi-Tenant Guardrails

- Never return API keys in clear text (mask as `***` on read).
- Use tenant-scoped query filters for all config/session access.
- Encrypt secrets at rest if client-managed keys are stored.
- Keep per-tenant rate/concurrency limits in config.
- Log config source used (payload/client/env) without logging secret values.

## 11) Suggested Production Baselines

- Default LLM: `gemini-2.5-flash`
- Default STT: `deepgram:nova-3`
- Default TTS: `deepgram:aura-2` with `athena`
- Voice pods target: 60 active rooms/pod metric for HPA
- Pod disruption budget: never evict pod with active sessions
- Graceful drain timeout: >= max expected call length

## 12) API Contract Extensions (Implemented)

`POST /api/calls` and `POST /api/calls/bulk` accept `providerConfig` to override runtime provider selection per request:

- `providerConfig.llm`
- `providerConfig.stt`
- `providerConfig.tts`
- `providerConfig.sip`

This is optional and merges with client config + env defaults.

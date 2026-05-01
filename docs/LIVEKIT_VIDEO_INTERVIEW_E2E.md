# LiveKit Video Interview Agent - End-to-End Design

This document defines how to build a **video AI interview agent** on top of your existing LiveKit infrastructure (`backend-node` + `agent-python`) and a candidate-facing React app.

It is designed for your requirement that backend APIs should provide only:
- Candidate data
- Interview metadata (job role, round rules, duration, evaluation schema, etc.)

---

## 1) Target Outcome

Build a real-time interview system where:
- Candidate joins from React app (camera + mic).
- AI interviewer joins same LiveKit room as an agent participant.
- Agent can hear (STT), reason (LLM), speak (TTS), and optionally analyze video frames (vision).
- Session state is tracked reliably across frontend, backend, and agent.
- Final result includes transcript, summary, and structured evaluation.

---

## 2) High-Level Architecture

```text
Candidate React App
  -> POST /api/interviews/session/start
     (candidateId + interviewId)
  <- { roomName, participantToken, participantIdentity, sessionId }

Candidate React App
  -> Connect to LiveKit room with participantToken

Backend Node
  -> createDispatch(roomName, AGENT_NAME, metadata)

Python Agent (LiveKit Worker)
  -> receives dispatch metadata
  -> loads interview context + runtime model config
  -> joins room, runs interview
  -> streams transcript/evaluation events
  -> stores completion report in MongoDB

Candidate React App
  -> subscribes to room/agent state + transcript stream
  -> renders interview status and completion screen
```

---

## 3) Components to Reuse vs Add

### Reuse from current codebase

- `backend-node/src/livekit.js`
  - Already has `createDispatch()` and `cancelDispatch()`.
- `backend-node/src/api.js`
  - Already has token creation pattern (`/api/playground/token`).
- `agent-python/agent_entrypoint.py`
  - Already handles dispatch metadata, runtime provider config, transcript persistence, summary generation.

### Add for interview use case

- Backend interview session endpoints:
  - `POST /api/interviews/session/start`
  - `POST /api/interviews/session/end`
  - `GET /api/interviews/session/:sessionId`
  - `POST /api/interviews/session/:sessionId/event` (optional for client-side markers)
- Collections:
  - `interviews`
  - `interview_sessions`
  - `interview_events`
  - `interview_evaluations`
- Candidate React app (new app or new route in `dashboard-react`) with explicit state machine.
- New agent entrypoint for interview mode (recommended): `agent-python/interview_agent_entrypoint.py`

---

## 4) API Contract (Minimal and Stable)

Keep this strict: frontend only sends candidate identity + interview id.

### `POST /api/interviews/session/start`

Request:
```json
{
  "candidateId": "cand_123",
  "interviewId": "int_456"
}
```

### `POST /api/interviews/getToken` (LiveKit standard token endpoint)

Implements the documented endpoint format so frontend SDK `TokenSource.endpoint()` can be used.

Request accepts documented optional fields:
- `room_name`
- `participant_identity`
- `participant_name`
- `participant_metadata`
- `participant_attributes`
- `room_config` (pass-through for agent dispatch configuration)

Response:
```json
{
  "server_url": "wss://<your-livekit-host>",
  "participant_token": "<jwt>"
}
```

### Interview listing and evaluation APIs

- `GET /api/interviews/sessions?limit=100&status=completed&candidateId=...`
- `GET /api/interviews/session/:sessionId`
- `GET /api/interviews/evaluations/:sessionId`

Session records now include:
- `jd` (id/title/text/url/version)
- `interviewRules`
- `interviewMeta.customFields`
- `interviewMeta.instructions`

Backend resolves and injects all metadata:
- candidate profile
- JD / role context
- round config
- scoring schema
- model/provider overrides

Response:
```json
{
  "sessionId": "sess_abc",
  "roomName": "interview-int_456-cand_123-20260501",
  "participantIdentity": "candidate_cand_123",
  "participantName": "Candidate",
  "token": "<livekit-jwt>",
  "wsUrl": "wss://<your-livekit-host>",
  "expiresAt": "2026-05-01T13:45:00.000Z"
}
```

### Agent dispatch metadata (server -> LiveKit)

```json
{
  "mode": "video_interview",
  "sessionId": "sess_abc",
  "interviewId": "int_456",
  "candidateId": "cand_123",
  "candidateProfile": {
    "name": "Jane Doe",
    "yearsExperience": 4,
    "skills": ["React", "Node.js", "PostgreSQL"]
  },
  "interviewMeta": {
    "title": "Full Stack Engineer L2",
    "durationMinutes": 35,
    "language": "en",
    "difficulty": "mid",
    "mustAskTopics": ["system design", "debugging", "api design"],
    "scoringRubric": {
      "communication": 20,
      "problemSolving": 30,
      "technicalDepth": 30,
      "ownership": 20
    }
  },
  "providerConfig": {
    "llm": { "provider": "openai", "model": "gpt-4o" },
    "stt": { "provider": "deepgram", "model": "nova-3" },
    "tts": { "provider": "cartesia", "voice": "professional_female" }
  },
  "vision": {
    "enabled": true,
    "sampleEverySeconds": 10
  }
}
```

---

## 5) Candidate App State Management (Critical)

Use an explicit finite-state approach; do not rely on scattered booleans.

Recommended states:
- `idle`
- `creating_session`
- `connecting_room`
- `preflight` (camera/mic checks)
- `waiting_for_agent`
- `interview_active`
- `reconnecting`
- `ending`
- `completed`
- `failed`

Recommended context store:
- `session`: sessionId, roomName, token, wsUrl
- `connection`: roomConnectionState, reconnectAttempts
- `media`: micEnabled, camEnabled, selectedDevices, permissions
- `agent`: participantIdentity, agentState, lastSpokeAt
- `interview`: startedAt, remainingSeconds, currentQuestionId, transcript
- `errors`: lastError, recoverable

Transition rules:
- `creating_session -> connecting_room`: after successful start API.
- `connecting_room -> preflight`: room connected + local tracks published.
- `preflight -> waiting_for_agent`: candidate ready.
- `waiting_for_agent -> interview_active`: agent participant detected + first greeting.
- Any connected state -> `reconnecting`: on connection loss.
- `reconnecting -> interview_active`: on successful recovery.
- `interview_active -> ending`: timer expiry, user end, or agent end tool.
- `ending -> completed`: final backend confirmation.

Implementation note:
- Use a reducer (`useReducer`) or XState.
- Keep LiveKit room object outside serializable state (ref/store), but emit normalized events into reducer.

---

## 6) LiveKit Frontend Integration Pattern (React)

Use:
- `livekit-client`
- optionally `@livekit/components-react` for faster UI scaffolding.

Flow:
1. Call `POST /api/interviews/session/start`.
2. Connect room with returned token.
3. Publish mic+camera tracks.
4. Listen to:
   - participant connected/disconnected
   - track subscribed/unsubscribed
   - room connection state
   - data channel/text stream events for transcript + structured progress
5. On unload/end -> call `POST /api/interviews/session/end`.

Important:
- Never generate LiveKit token on frontend.
- Rotate/reissue token if interview duration can exceed token TTL.

---

## 7) Agent Design (Python, LiveKit Agents)

Create a dedicated interview agent entrypoint to avoid overloading telephony flow.

Suggested structure:
- `interview_agent_entrypoint.py`
- `interview/`
  - `context_loader.py`
  - `question_policy.py`
  - `evaluation.py`
  - `vision.py`
  - `prompts.py`

Agent responsibilities:
- Parse metadata from dispatch.
- Build interview plan from `interviewMeta.mustAskTopics`.
- Ask questions adaptively based on candidate answers.
- Keep answers concise and interview-focused.
- Record transcript events in Mongo.
- Emit structured interview progress events (current topic, question index, time left).
- Produce final JSON evaluation.

Model recommendations:
- LLM: `gpt-4o` or `claude-3.5-sonnet` equivalent plugin path.
- STT: Deepgram Nova-3.
- TTS: Cartesia/ElevenLabs.
- Vision: optional frame sampling to avoid latency/cost spikes.

---

## 8) Vision Layer (Optional but Recommended)

Do not run continuous heavy vision inference every frame.

Recommended strategy:
- Sample one frame every 8-12 seconds.
- Analyze only interview signals:
  - face present / not present
  - major attention drift
  - obvious technical issues (very dark frame, frozen feed)
- Store as low-weight behavioral signals; never as final hiring decision.

Guardrails:
- Explicit candidate consent.
- Privacy notice and retention policy.
- Avoid sensitive attribute inference.

## 8.1) Avatar Output (Official LiveKit Plugin)

This project now supports optional avatar output using LiveKit's official avatar plugin flow:
- Plugin path: Simli (`livekit-plugins-simli`)
- Agent behavior:
  - Creates `simli.AvatarSession(...)`
  - `await avatar.start(session, room=ctx.room)`
  - Starts `AgentSession` with `audio_output=False` so avatar worker publishes synchronized audio/video

Environment flags in `agent-python/.env`:
- `ENABLE_AVATAR=true`
- `AVATAR_PROVIDER=simli`
- `SIMLI_API_KEY=<your-key>`
- `SIMLI_FACE_ID=<your-face-id>`
- `SIMLI_EMOTION_ID=<optional>`

If avatar env values are missing, agent gracefully falls back to voice-only mode.

## 8.2) Periodic frame analysis (configurable)

The interview agent supports lightweight frame analysis without storing full video streams.

Environment configuration:
- `FRAME_ANALYSIS_ENABLED=true`
- `FRAME_ANALYSIS_INTERVAL_SECONDS=10`
- `FRAME_ANALYSIS_REQUIRE_CAMERA=true`
- `FRAME_ANALYSIS_REQUIRE_SCREEN=false`

Behavior:
- Samples room video context every N seconds.
- Writes `frame_analysis` events to `interview_events`.
- Aggregates `cheating_flags` into `interview_evaluations`:
  - `camera_not_visible`
  - `screen_share_missing`
  - `multiple_remote_participants`
  - `no_recent_frame`

---

## 9) Interview Completion Payload

Persist final output in `interview_evaluations`:

```json
{
  "sessionId": "sess_abc",
  "candidateId": "cand_123",
  "interviewId": "int_456",
  "status": "completed",
  "summary": "Candidate shows strong API design skills...",
  "scores": {
    "communication": 16,
    "problemSolving": 24,
    "technicalDepth": 26,
    "ownership": 14,
    "overall": 80
  },
  "strengths": ["clear thought process", "good trade-off awareness"],
  "gaps": ["limited distributed systems depth"],
  "recommendation": "shortlist",
  "completedAt": "2026-05-01T13:40:12.000Z"
}
```

---

## 10) End-to-End Sequence

1. Candidate opens interview link.
2. React app calls `/api/interviews/session/start`.
3. Backend creates room token + dispatches agent with metadata.
4. Candidate joins room and publishes tracks.
5. Agent joins and starts interview.
6. Transcript + progress streamed live to frontend/dashboard.
7. Timeout/user end/agent end triggers completion flow.
8. Agent stores summary + evaluation.
9. Frontend fetches final result (`GET /api/interviews/session/:sessionId`).

---

## 11) Reliability and Ops Checklist

- Use idempotency key in `session/start` to prevent duplicate rooms.
- Add heartbeat (`lastSeenAt`) updates from frontend.
- Mark abandoned sessions after timeout.
- Persist intermediate transcript chunks continuously (not only at the end).
- Add reconnect-safe frontend logic (resume by `sessionId`).
- Instrument metrics:
  - join latency
  - STT latency
  - LLM first-token latency
  - drop/reconnect count
  - interview completion rate

---

## 12) Security and Compliance

- Token generation only on backend.
- Room permissions least-privilege (`roomJoin`, publish/subscribe as required).
- Encrypt sensitive candidate metadata at rest.
- Mask PII in logs and traces.
- Add configurable data retention and delete endpoints for interview records.

---

## 13) Suggested Implementation Plan

Phase 1 (Core):
- Add interview session APIs in `backend-node`.
- Add candidate React interview page with reducer-based state machine.
- Add `interview_agent_entrypoint.py` with audio interview first.

Phase 2 (Quality):
- Structured rubric evaluation output.
- Live progress events via data channel.
- Reconnect and resume handling.

Phase 3 (Vision + analytics):
- Add sampled video analysis.
- Add interviewer quality dashboard and session replay tooling.

---

## 14) LiveKit Docs Mapping Used

Primary docs categories used for this design:
- Agents framework (sessions, workflows, multimodality, models)
- Frontend session/auth/agent-state guides
- Transport state synchronization (participant attributes, room metadata)
- Agent dispatch + server API patterns
- Python agent examples, especially:
  - `complex-agents/nova-sonic/form_agent.py` (structured interview/form pattern)
  - `docs/examples/rpc_agent` (state management and RPC/event patterns)
  - `complex-agents/vision/agent.py` (video frame ingestion pattern)


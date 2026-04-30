# End-to-End Call Flow

This document explains how a call moves through the AI Calling Platform from dashboard action to final summary/reporting.

## Components Involved

- `dashboard-react`: user actions (single call, bulk, campaigns, recovery, exports)
- `backend-node`: API, dispatch orchestration, campaign sequencing, persistence
- `agent-python`: live conversation agent (LLM/STT/TTS), transcript + summary writer
- `livekit-server` + `livekit-sip`: room/session and SIP bridge
- `MongoDB`: source of truth for clients, configs, calls, transcripts, campaigns
- `Redis` (BullMQ infra): queue-related plumbing and future async fanout support

## 1) Call Initiation Paths

### A. Single call from Calls page

1. Dashboard sends `POST /api/calls` with `{ clientId, phone, name? }`.
2. Backend validates client and creates a `calls` record:
   - `status: queued`
   - `room_name`, `created_at`, `metadata`, etc.
3. Backend creates LiveKit agent dispatch (`createDispatch`).
4. Backend updates call to:
   - `status: dispatched`
   - stores `dispatch_id`

### B. Bulk calls from Calls page

1. Dashboard sends `POST /api/calls/bulk` with contact list.
2. Backend loops contacts and internally runs the same single-call flow per contact.

### C. Campaign start

1. User imports contacts via `POST /api/campaigns/import` (CSV/XLS/XLSX).
2. Contacts are stored as `pending` under a campaign.
3. User clicks Start -> `POST /api/campaigns/:id/start`.
4. Backend dispatches campaign contacts (currently configured one-by-one for provider safety).

## 2) Agent Runtime Flow

1. LiveKit assigns a job to `agent-python` worker for the room.
2. Agent loads:
   - client profile (`clients`)
   - provider config (`client_configs`)
   - prompt + summary prompt + extraction schema
3. Agent places SIP participant using trunk config.
4. During the call:
   - STT transcribes user speech
   - LLM generates responses
   - TTS synthesizes speech
   - transcript entries are written incrementally to `transcript_entries`
5. On normal call end:
   - consolidated transcript is built
   - summarization/extraction runs
   - `calls` updated with `summary`, `extracted_fields`, final status

## 3) Status Lifecycle

Typical status transitions:

- `queued` -> `dispatched` -> `in-progress` -> `completed`
- failure path: `queued/dispatched/in-progress` -> `failed`

Campaign contact statuses:

- `pending` -> `dispatched` (or `failed` if dispatch creation fails)

## 4) Recovery Flow (Missing Summary)

If a call has transcript but summary is empty:

1. User clicks **Recover summary** in Calls detail modal.
2. Backend endpoint `POST /api/calls/:id/recover-summary` runs `agent-python/recover_stuck_calls.py`.
3. Recovery script rebuilds transcript from `transcript_entries`, reruns summary+extraction, updates `calls`.
4. If summary generation fails (quota/timeout), endpoint returns error (not false success).

## 5) Delete / Cancel Flow (Wrong or Duplicate Number)

Allowed only before active completion:

1. User deletes call from Calls page (single or selected).
2. Frontend calls `DELETE /api/calls/:id`.
3. Backend allows delete only for `queued` / `dispatched`.
4. Backend attempts best-effort LiveKit dispatch cancel, then removes call + transcript entries.

## 6) Reporting Flow

Calls page supports export:

- CSV and Excel-compatible download
- includes base fields:
  - mobile number, name, status, client
- includes dynamic extracted fields based on client schema/data

This enables client-specific reporting where each client can have different extraction fields.

## 7) Key Data Collections

- `clients`: profile, prompts, extraction schema
- `client_configs`: provider credentials/models per client
- `calls`: per-call lifecycle, status, summary, extracted fields
- `transcript_entries`: granular transcript stream
- `campaigns`: campaign metadata
- `contacts`: imported campaign contacts

## 8) Common Failure Points and What to Check

- SIP invite fails / media timeout: verify trunk credentials, provider reachability, RTP path
- LLM 429/504: provider quota, model latency, fallback/retry policy
- TTS 401: invalid API key or wrong provider model/voice
- Missing summary: use recovery endpoint and check summarizer provider logs
- Campaign start issues: validate import schema (`phone` required), campaign id presence

## 9) Practical Scaling Notes

- Architecture is horizontally scalable (multiple backend and agent workers).
- Current campaign dispatch is intentionally serialized for provider limits.
- For higher throughput, increase controlled concurrency + retries/fallbacks + provider-specific rate limits.

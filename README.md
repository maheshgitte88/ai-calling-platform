# AI Outbound Calling Platform

A scalable, multi-tenant AI calling platform with LiveKit (self-hosted), Python AI agents, Node.js backend, React dashboard, and MongoDB.

## Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  React Dashboard │────▶│  Node.js Backend  │────▶│     MongoDB      │
│     (port 3000)  │     │   (port 4040)     │     │   (port 27017)   │
└─────────────────┘     └────────┬─────────┘     └─────────────────┘
                                 │
                                 │  LiveKit Dispatch
                                 ▼
┌─────────────────┐     ┌──────────────────┐
│  LiveKit Server  │◀───▶│  Python Agent     │
│  (self-hosted)   │     │  (LLM/STT/TTS)    │
└────────┬────────┘     └──────────────────┘
         │
         │  SIP Trunk (Vobiz / Vonage)
         ▼
┌─────────────────┐
│  Phone Network   │
└─────────────────┘
```

## Features

- **Multi-tenant**: Per-client LLM, STT, TTS, SIP provider configuration
- **Providers**:
  - LLM: Gemini, OpenAI, Grok (xAI), DeepSeek
  - STT: Deepgram, AssemblyAI
  - TTS: ElevenLabs, Cartesia, Deepgram
  - SIP: Vobiz (default), Vonage
- **Default model policy**: `gemini-2.5-flash` as default LLM, with per-client/per-call overrides
- **Runtime config precedence**: API payload override -> client config -> `.env` defaults
- **Single & bulk calls**: API supports 1 or many contacts per request
- **Dashboard**: Clients, config, calls, campaigns, playground
- **Pricing-aware UI**: Provider selection with pricing metadata

## Quick Start

### Prerequisites

- Node.js 20+
- Python 3.10+
- MongoDB
- Redis
- Self-hosted LiveKit server with SIP trunk configured

### Local Development

1. **Backend** (Node.js)

   ```bash
   cd backend-node
   cp ../.env.example .env.local
   npm install
   npm run dev
   ```

2. **Agent** (Python)

   ```bash
   cd agent-python
   pip install -r requirements.txt
   # Set env vars: LIVEKIT_*, MONGODB_URI, GOOGLE_API_KEY
   python agent_entrypoint.py dev
   ```

3. **Dashboard** (React)

   ```bash
   cd dashboard-react
   npm install
   npm run dev
   ```

4. **MongoDB & Redis** (if not running)

   ```bash
   docker run -d -p 27017:27017 mongo:7
   docker run -d -p 6379:6379 redis:7-alpine
   ```

### Docker (Production)

```bash
cp .env.example .env
# Edit .env with LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET
docker-compose up -d
```

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/calls` | Single call: `{ clientId, phone, name?, providerConfig? }` |
| POST | `/api/calls/bulk` | Bulk: `{ clientId, contacts: [{ phone, name? }], providerConfig? }` |
| GET | `/api/calls` | List calls |
| GET | `/api/clients` | List clients |
| POST | `/api/clients` | Create client |
| GET | `/api/clients/:id/config` | Get client config |
| POST | `/api/clients/:id/config` | Save client config (LLM/STT/TTS/SIP) |
| POST | `/api/campaigns/import` | Import contacts (Excel/CSV) |
| POST | `/api/campaigns/:id/start` | Start campaign |
| GET | `/api/providers` | Provider metadata with pricing |

## Client Config (MongoDB)

Each client has a config document:

```json
{
  "client_id": "uuid",
  "llm": { "provider": "gemini", "apiKey": "...", "model": "gemini-2.0-flash" },
  "stt": { "provider": "deepgram", "apiKey": "...", "model": "nova-3" },
  "tts": { "provider": "elevenlabs", "apiKey": "...", "voice": "Rachel", "model": "eleven_turbo_v2_5" },
  "sip": { "provider": "vobiz", "trunkId": "ST_xxx", "fromNumber": "+1234567890" },
  "concurrency_limit": 5
}
```

## Environment

| Variable | Required | Description |
|----------|----------|-------------|
| `LIVEKIT_URL` | Yes | LiveKit server URL (ws://host:7880) |
| `LIVEKIT_API_KEY` | Yes | LiveKit API key |
| `LIVEKIT_API_SECRET` | Yes | LiveKit API secret |
| `MONGODB_URI` | Yes | MongoDB connection string |
| `REDIS_URL` | No | Redis URL (default: redis://localhost:6379) |
| `GOOGLE_API_KEY` | No | For post-call summarization |
| `DEFAULT_LLM_PROVIDER` | No | Default LLM provider (default: `gemini`) |
| `DEFAULT_LLM_MODEL` | No | Default LLM model (default: `gemini-2.5-flash`) |
| `DEFAULT_STT_PROVIDER` | No | Default STT provider (default: `deepgram`) |
| `DEFAULT_STT_MODEL` | No | Default STT model (default: `nova-3`) |
| `DEFAULT_TTS_PROVIDER` | No | Default TTS provider (default: `deepgram`) |
| `DEFAULT_TTS_MODEL` | No | Default TTS model (default: `aura-2`) |
| `DEFAULT_TTS_VOICE` | No | Default TTS voice (default: `athena`) |

## Documentation

- Full architecture and scaling guide: `docs/ARCHITECTURE.md`
- End-to-end call lifecycle and status flow: `docs/CALL_FLOW.md`
- Video interview agent end-to-end guide: `docs/LIVEKIT_VIDEO_INTERVIEW_E2E.md`
- SIP setup notes: `docs/SIP.md`

## Interview Agent (Phase 1)

- Backend endpoints:
  - `POST /api/interviews/session/start`
  - `POST /api/interviews/session/:sessionId/end`
  - `GET /api/interviews/session/:sessionId`
  - `POST /api/interviews/session/:sessionId/event`
- Candidate UI route: `/interview-candidate` (in `dashboard-react`)
- Python worker entrypoint: `agent-python/interview_agent_entrypoint.py`
  - Run with: `python interview_agent_entrypoint.py dev`
  - Use `INTERVIEW_AGENT_NAME=ai-interview-agent` in backend + agent env to target this worker.

## License

MIT

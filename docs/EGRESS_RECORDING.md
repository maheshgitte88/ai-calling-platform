# LiveKit Egress Recording Guide (Self-Hosted)

This guide explains how to run and operate LiveKit Egress for interview recording in this project.

## Why Egress Is Required

For self-hosted LiveKit, recording is **not** handled by `livekit-server` itself.

To record interview rooms, you must run a separate `livekit/egress` service.

In this project:
- `recordingEnabled = true` starts a RoomComposite recording
- `recordingEnabled = false` skips recording

## Current Application Behavior

Backend interview flow starts/stops recording through LiveKit Egress:

- Start path:
  - `POST /api/interviews/session/start` stores recording flag in session metadata
  - On candidate room connect (or resolve fallback), backend calls Egress start
- End path:
  - `POST /api/interviews/session/:sessionId/end` stops active egress

Session fields used for status:
- `egress_id`
- `recording_status` (`pending`, `starting`, `active`, `ended`, `failed`, `disabled`)
- `recording_error`
- `recording_started_at`, `recording_ended_at`
- `recording_filepath`

## Prerequisites

- Running LiveKit server (`7880`) and Redis
- LiveKit API key/secret (same values used by egress)
- Azure Blob Storage account + container
- Docker installed on egress host
- Recommended egress host size for RoomComposite: **4 vCPU minimum**

## Environment Variables (Backend)

In `backend-node/.env`:

```env
AZURE_STORAGE_ACCOUNT_NAME=your-account
AZURE_STORAGE_ACCOUNT_KEY=your-key
AZURE_STORAGE_CONTAINER_NAME=interview-recordings
```

Also ensure:

```env
LIVEKIT_URL=ws://<livekit-host>:7880
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
```

## Egress Service Configuration

Create file: `~/livekit-egress/config.yaml`

```yaml
api_key: "your-livekit-api-key"
api_secret: "your-livekit-api-secret"
ws_url: "ws://<livekit-host>:7880"

redis:
  address: "<redis-host>:<redis-port>"
  password: "<redis-password>" # omit if not needed

health_port: 8081
prometheus_port: 6789

logging:
  level: info

file_outputs:
  - azure:
      account_name: "your-azure-account"
      account_key: "your-azure-key"
      container_name: "interview-recordings"

# Required by RoomComposite/Web egress in many deployments.
enable_chrome_sandbox: false
```

## Run Egress Docker Container

```bash
docker pull livekit/egress:latest

docker run -d \
  --name livekit-egress \
  --restart unless-stopped \
  --network host \
  --cap-add=SYS_ADMIN \
  -v $HOME/livekit-egress/config.yaml:/out/config.yaml \
  -e EGRESS_CONFIG_FILE=/out/config.yaml \
  livekit/egress:latest
```

## Verify Egress Is Healthy

```bash
docker ps | grep livekit-egress
docker logs -f livekit-egress
```

Healthy examples:
- `service ready`
- `cpu available: 4.000000 max cost: 4.000000`

## Recording Lifecycle Logs (Backend)

Backend logs include recording diagnostics:

- `[recording] start claimed`
- `[recording] startRoomCompositeRecording request`
- `[recording] startRoomCompositeRecording success`
- `[recording] startRoomCompositeRecording failed`
- `[recording] stopRecordingEgress request/success/failed`

Use these logs first when recording fails.

## Common Failure Reasons

### 1) `twirp error unknown: no response from servers`

Usually means LiveKit could not route request to a healthy egress worker.

Checks:
- egress container running
- same LiveKit API key/secret as server
- same Redis cluster as LiveKit
- egress can reach `ws_url`

### 2) `not enough cpu for some egress types`

RoomComposite needs higher CPU. With 2 vCPU, recording may fail.

Recommendation:
- use dedicated egress node with **4+ vCPU**

### 3) `Start signal not received` / `Source closed`

Startup race or room source closed quickly.

Checks:
- room exists and stays active long enough
- connectivity between egress and LiveKit
- no container restarts during startup

## Capacity Guidance

RoomComposite recording is CPU-intensive.

Practical baseline:
- 4 vCPU egress: safe for about 1 concurrent RoomComposite, maybe 2 with careful tuning
- 2 vCPU egress: often insufficient for stable RoomComposite

## Security Notes

- Never commit real Azure or LiveKit secrets to git.
- Rotate secrets if shared in logs/chat.
- Restrict host/network access to trusted sources.


# Local LiveKit + SIP (Docker)

Self-contained local setup for LiveKit server + LiveKit SIP, using the API key
and Redis Cloud already configured for this project.

## Files

- `livekit.yaml` — LiveKit server config (port 7880, RTC, Redis).
- `sip.yaml` — LiveKit SIP config (signaling 5060, RTP 10000-10100).
- `docker-compose.yml` — One-shot stack that starts both services on a shared
  Docker network so SIP can reach LiveKit at `ws://livekit:7880`.

## Quick start (Docker Compose)

From this directory:

```bash
docker compose pull
docker compose up -d
docker compose ps
docker compose logs -f livekit
docker compose logs -f sip
```

Stop / clean:

```bash
docker compose down
```

After updating `livekit.yaml` or `sip.yaml`:

```bash
docker compose restart livekit
docker compose restart sip
# or full recreate
docker compose up -d --force-recreate
```

## Quick start (raw `docker run`)

Use this if you want to run without compose. Both containers share a
user-defined network so SIP can reach LiveKit at `ws://livekit:7880`.

```bash
# 1. Create shared network
docker network create livekit-net

# 2. Pull images
docker pull livekit/livekit-server:latest
docker pull livekit/sip:latest

# 3. Run LiveKit server
docker run -d \
  --name livekit \
  --restart unless-stopped \
  --network livekit-net \
  -p 7880:7880 \
  -p 7881:7881/tcp \
  -p 50000-50100:50000-50100/udp \
  -v "$PWD/livekit.yaml:/etc/livekit.yaml:ro" \
  livekit/livekit-server:latest \
  --config /etc/livekit.yaml

# 4. Run LiveKit SIP
docker run -d \
  --name livekit-sip \
  --restart unless-stopped \
  --network livekit-net \
  -p 5060:5060/udp \
  -p 10000-10100:10000-10100/udp \
  -v "$PWD/sip.yaml:/etc/sip.yaml:ro" \
  -e SIP_CONFIG_FILE=/etc/sip.yaml \
  livekit/sip:latest
```

PowerShell variant for the volume mount path: replace `"$PWD/..."` with
`"${PWD}/..."` or an absolute Windows path like
`"C:/AIVoiceAgents/ai-calling-platform/infra/livekit/livekit.yaml:/etc/livekit.yaml:ro"`.

## Verify

```bash
# Services up?
docker ps

# LiveKit reachable on the host
curl http://localhost:7880

# Logs
docker logs -f livekit
docker logs -f livekit-sip
```

A healthy LiveKit boot logs `starting LiveKit server` and connects to Redis.
A healthy SIP boot logs `starting SIP service` and `connected to LiveKit`.

## App env to point at this local stack

In `agent-python/.env`, `backend-node/.env`, and `dashboard-react` env:

```env
LIVEKIT_URL=ws://localhost:7880
LIVEKIT_API_KEY=myapikey
LIVEKIT_API_SECRET=217x9oGhYOCLYKYwklA5yl93YYKTX/I+D1LhzC5Aixs=
```

For browser clients connecting from `localhost`, this is sufficient. If you
test from another device on the LAN, replace `localhost` with the host's LAN IP
in the client URL **and** consider setting `rtc.use_external_ip: false` plus
explicit `node_ip` in `livekit.yaml` so ICE candidates are reachable.

## Common gotchas

### Docker Desktop (Windows / Mac)

- `--network host` is **not** supported on Docker Desktop. This setup uses an
  explicit user-defined bridge network plus port publishing instead.
- Publishing wide UDP ranges is slow on Docker Desktop. The RTP range is kept
  small (10000-10100). Increase only if you need many concurrent SIP calls.
- If WebRTC fails to connect from the browser, set in `livekit.yaml`:

  ```yaml
  rtc:
    use_external_ip: false
    node_ip: 127.0.0.1
  ```

### SIP container cannot reach LiveKit

- `ws_url` in `sip.yaml` must be `ws://livekit:7880` (service/container name on
  the shared Docker network), not `127.0.0.1:7880` — `127.0.0.1` inside the SIP
  container is the SIP container itself, not LiveKit.

### Auth mismatch

- `keys.myapikey` (value) in `livekit.yaml` MUST equal `api_secret` in
  `sip.yaml`. The key name `myapikey` MUST equal `api_key` in `sip.yaml`.

### Redis connectivity

- Both files use the same Redis Cloud endpoint with `username: default` and the
  shared password. If LiveKit logs `dial tcp ... i/o timeout` or similar, your
  network is blocking outbound TCP to that port — open it or run a local Redis
  and update both files to point at it.

### Ports already in use

- 7880 / 5060 / 7881 / 10000-10100 / 50000-50100 must be free on the host.
  On Windows, check with `netstat -ano | findstr :7880`.

## Production / EC2 deployment

For deploying to AWS EC2 (Linux, `--network host` works there), see
[`docs/LiveKitEC2.md`](../../docs/LiveKitEC2.md).



Commands Going Forward
Start LiveKit/SIP first:

docker compose -f infra/livekit/docker-compose.yml up -d
Then start the app stack:


docker compose up -d --build
Check logs:

docker logs -f livekit
docker logs -f livekit-sip
docker logs -f ai-calling-platform-backend-1
docker logs -f ai-calling-platform-agent-1
docker logs -f ai-calling-platform-interview-agent-1

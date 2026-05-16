# LiveKit + SIP on EC2 (Docker) - Deployment and Update Guide

This guide covers how to deploy, update, and verify `livekit-server` and `livekit-sip` on AWS EC2 using Docker.

## Scope

- LiveKit server container
- LiveKit SIP container
- Config alignment (`livekit.yaml`, `sip.yaml`)
- AWS security group and networking checks
- Safe update procedure

## Prerequisites

- EC2 with Docker installed
- Existing config files:
  - `~/livekit.yaml`
  - `~/sip.yaml`
- Access to Redis used by both services
- Running containers (if updating):
  - `livekit`
  - `livekit-sip`

## Required Ports (AWS Security Group)

| Port | Protocol | Purpose |
|---|---|---|
| `7880` | TCP | LiveKit API / WS |
| `7881` | UDP | WebRTC transport |
| `59000-59100` | UDP | WebRTC / RTP media range (matches repo `livekit.yaml`) |
| `5060` | UDP | SIP signaling (or your custom SIP port) |

Security recommendation:
- Do **not** keep SIP `5060` open to `0.0.0.0/0` unless required.
- Restrict to trusted provider/source IPs where possible.

## Config Consistency Checklist (Critical)

Before restart/update, validate:

### 1) API key/secret must match

`livekit.yaml`

```yaml
keys:
  myapikey: "your-secret"
```

`sip.yaml`

```yaml
api_key: myapikey
api_secret: your-secret
```

### 2) Redis must be identical in both configs

```yaml
redis:
  address: redis-host:port
  password: your-password
```

### 3) SIP WS URL must point to LiveKit

```yaml
ws_url: ws://127.0.0.1:7880
```

This is valid when SIP runs with `--network host`.

## Example Config Files (Copy-Paste Ready)

Use these as base templates and replace secrets/hosts for your environment.

### `livekit.yaml`

```yaml
port: 7880

rtc:
  tcp_port: 7881
  use_external_ip: true
  port_range_start: 59000
  port_range_end: 59100

keys:
  myapikey: "YOUR_LIVEKIT_API_SECRET"

bind_addresses:
  - 0.0.0.0

redis:
  address: redis-19322.c512.ap-south-1-1.ec2.red.redis-cloud.com:19322
  password: YOUR_REDIS_PASSWORD
```

### `sip.yaml`

```yaml
api_key: myapikey
api_secret: YOUR_LIVEKIT_API_SECRET

# Because SIP container runs with --network host
ws_url: ws://127.0.0.1:7880

redis:
  address: redis-19322.c512.ap-south-1-1.ec2.red.redis-cloud.com:19322
  password: YOUR_REDIS_PASSWORD

# SIP signaling
sip_port: 5060

# RTP media range for SIP side
rtp_port: 10000-20000
```

Notes:
- `keys.myapikey` in `livekit.yaml` must match `api_key` in `sip.yaml`.
- `keys.myapikey` secret value must match `api_secret` in `sip.yaml`.
- Redis host/password must be the same in both files.
- If you change `sip_port`, also update provider trunk config and security group.

## Safe Update Procedure

Run these commands on EC2:

### Step 1: Pull latest images

```bash
docker pull livekit/livekit-server:latest
docker pull livekit/sip:latest
```

### Step 2: Stop old containers

```bash
docker stop livekit livekit-sip
```

### Step 3: Remove old containers

```bash
docker rm livekit livekit-sip
```

### Step 4: Start LiveKit server

```bash
docker run -d \
  --name livekit \
  --restart unless-stopped \
  -p 7880:7880 \
  -p 7881:7881/udp \
  -p 59000-59100:59000-59100/udp \
  -v ~/livekit.yaml:/livekit.yaml:ro \
  livekit/livekit-server:latest \
  --config /livekit.yaml
```

### Step 5: Start LiveKit SIP

```bash
docker run -d \
  --name livekit-sip \
  --restart unless-stopped \
  --network host \
  -v ~/sip.yaml:/sip/config.yaml:ro \
  livekit/sip:latest
```

## Post-Deployment Verification

### 1) Container health

```bash
docker ps
```

Expected:
- `livekit` is up
- `livekit-sip` is up

### 2) Logs

```bash
docker logs -f livekit
docker logs -f livekit-sip
```

### 3) LiveKit endpoint check

Open:
- `http://<EC2_PUBLIC_IP>:7880`

You should get a valid LiveKit server response.

## Common Issues and Fixes

### SIP not connecting

Check:
- API key mismatch between `livekit.yaml` and `sip.yaml`
- Incorrect `ws_url`
- Redis mismatch

### Call connects but no audio / media timeout

Check:
- UDP ports blocked (`7881`, `59000-59100`)
- Security group or NACL blocking RTP traffic

### Random SIP calls in logs

This is common internet SIP scanning behavior.

Mitigation:
- Restrict SIP port exposure
- Use trusted source IP allow-list
- Optionally move SIP to custom port (e.g., `15060`) in provider + SIP config

## Optional: Docker Compose Setup

Use this for simpler lifecycle management:

```yaml
version: "3.8"
services:
  livekit:
    image: livekit/livekit-server:latest
    restart: unless-stopped
    ports:
      - "7880:7880"
      - "7881:7881/udp"
      - "59000-59100:59000-59100/udp"
    volumes:
      - ./livekit.yaml:/livekit.yaml:ro
    command: --config /livekit.yaml

  sip:
    image: livekit/sip:latest
    restart: unless-stopped
    network_mode: host
    volumes:
      - ./sip.yaml:/sip/config.yaml:ro
```

Update commands:

```bash
docker compose pull
docker compose up -d
```

## Final Operational Checklist

- Latest images pulled
- Containers restarted cleanly
- Redis connected from both services
- SIP signaling listening on configured port
- AWS ports validated
- Basic call test passed (dispatch -> SIP -> media -> call end)

## Quick Summary

Update flow:
1. Pull latest images
2. Stop/remove old containers
3. Start `livekit`
4. Start `livekit-sip`
5. Verify logs, ports, and test call
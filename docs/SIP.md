# SIP Configuration for AI Calling Platform

This guide explains how to configure SIP trunks for outbound AI voice calls.

## Overview

The agent places outbound SIP calls via LiveKit's SIP API. Each call uses a **SIP trunk** that you create on your LiveKit server (self-hosted or LiveKit Cloud).

## Trunk ID

The trunk ID (e.g. `ST_MgmsF2eJdisa`) identifies the SIP trunk LiveKit uses to place outbound calls.

### Where to set it

1. **Per client (recommended)** – Dashboard → Client → Config → SIP → **Trunk ID**
2. **Environment fallback** – Set `OUTBOUND_TRUNK_ID` in `.env` when all clients share one trunk

### Creating an outbound trunk

For **self-hosted LiveKit**, do the same checks via **CLI/API** (not Cloud UI).

## Self-hosted trunk check

Use `lk` CLI against your server:

```bash
lk sip outbound list \
  --url ws://yourlivekithostInstanceIp:7880 \
  --api-key myapikey \
  --api-secret 'YOUR_SECRET'
```

If your trunk ID (`ST_MgmsF2eJdisa`) is not listed, it does not exist on that server.

## Get one trunk by ID

```bash
lk sip outbound get ST_MgmsF2eJdisa \
  --url ws://yourlivekithostInstanceIp:7880 \
  --api-key myapikey \
  --api-secret 'YOUR_SECRET'
```

If this returns not found, trunk is deleted/wrong server.

## Create new outbound trunk (self-hosted)

```bash
lk sip outbound create \
  --url ws://yourlivekithostInstanceIp:7880 \
  --api-key myapikey \
  --api-secret 'YOUR_SECRET' \
  --name "primary-outbound" \
  --address "<your-sip-provider-host>" \
  --numbers "SIP Phone Number With +91" \
  --auth-username "<provider-user -SIP UserName>" \
  --auth-password "<provider-pass- SIP Password>"
```

Then it will return a new `ST_...` trunk ID.

Correct command (self-hosted LiveKit)
Use these exact flag names (LiveKit CLI uses auth-user / auth-pass, not auth-username):


lk sip outbound create \
  --url ws://yourlivekithostInstanceIp:7880 \
  --api-key myapikey \
  --api-secret '217x9oGhYOYKYwklA5yl93YYK+D1LhzC5Aixs=' \
  --name "vobiz-outbound" \
  --address "dca6a.sip.vobiz.ai" \
  --transport "udp" \
  --numbers "+91171938" \
  --auth-user "voiceai" \
  --auth-pass "PUT_VOBIZ_PASSWORD_HERE"

## Update your app with new trunk ID

Set same ID in both places (or at least active one):
- `dashboard-react` client config → `SIP -> trunkId`
- `agent-python/.env` → `OUTBOUND_TRUNK_ID=ST_new...`

Then restart:
- backend
- agent worker

## Important for your case

Your error confirms this exactly:
- `requested sip trunk does not exist` = wrong/missing trunk ID on current server.
- Also keep an eye on `486 flood` after fix (rate-limit), so test with single-call concurrency first.

If you want, I can give you exact `lk` commands filled for your current server and number format step-by-step.


1. **LiveKit Cloud**: SIP → Create Outbound Trunk → configure your carrier (Twilio, Vonage, Vobiz, etc.) → copy the trunk ID.
2. **Self-hosted LiveKit**: Configure SIP in your LiveKit config (see [LiveKit SIP docs](https://docs.livekit.io/sip/)) → the trunk ID is assigned when the trunk is created.

## Configuration

| Field | Description |
|-------|-------------|
| **Trunk ID** | LiveKit SIP trunk ID (e.g. `ST_MgmsF2eJdisa`) |
| **From number** | Caller ID / CLI shown to the callee |

## "flood" (486) errors

If SIP logs show `"reason": "flood"`, the server is rejecting calls due to rate limiting:

- Reduce `CAMPAIGN_CONCURRENCY` or add delays between bulk calls
- Check your carrier's (Vobiz/Vonage/etc.) rate limits
- Review LiveKit SIP flood/antispam settings

## TTS: Cartesia "no audio frames" errors

If Cartesia TTS fails with `no audio frames were pushed for text`:

1. **Model**: Use `sonic-3` (not `sonic-3-stable`). The agent maps legacy names automatically.
2. **Connectivity**: Some TTS providers block traffic from certain datacenter IPs. If running from cloud/LiveKit, try a different network or upgrade the TTS provider plan.
3. **Voice**: Ensure the voice UUID is valid and from [Cartesia Voice Library](https://play.cartesia.ai/voices).

## References

- [LiveKit SIP documentation](https://docs.livekit.io/sip/)
- [CreateSIPParticipant API](https://docs.livekit.io/sip/placing-calls/)

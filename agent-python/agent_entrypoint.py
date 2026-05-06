"""
LiveKit AI Voice Agent - dispatches to calls with client-specific LLM/STT/TTS.
Uses client config from MongoDB to load providers dynamically.
"""

import asyncio
import inspect
import json
import logging
import os
import re
import uuid
from datetime import datetime, timedelta
from pathlib import Path

# Reduce log noise - keep only important messages
logging.getLogger("pymongo").setLevel(logging.WARNING)
logging.getLogger("urllib3").setLevel(logging.WARNING)
logging.getLogger("asyncio").setLevel(logging.WARNING)
logging.getLogger("livekit.agents").setLevel(logging.INFO)
logging.getLogger("livekit").setLevel(logging.INFO)

from dotenv import load_dotenv
load_dotenv(dotenv_path=Path(__file__).resolve().parent / ".env")

from livekit.agents import AgentSession, JobContext, WorkerOptions, cli, room_io
from livekit.agents.voice import Agent
from livekit.api import LiveKitAPI
from livekit.protocol.sip import CreateSIPParticipantRequest
from pymongo import MongoClient

# Provider factories
from providers.llm import get_llm
from providers.stt import get_stt
from providers.tts import get_tts

# Optional turn-detection plugins (recommended for SIP/noisy audio)
try:
    from livekit.plugins import silero
except Exception:  # pragma: no cover - optional dependency
    silero = None

try:
    from livekit.plugins.turn_detector.multilingual import MultilingualModel
except Exception:  # pragma: no cover - optional dependency
    MultilingualModel = None

try:
    from livekit.plugins import noise_cancellation
except Exception:  # pragma: no cover - optional dependency
    noise_cancellation = None

# Config
MONGODB_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017/ai_calling")
LIVEKIT_URL = os.getenv("LIVEKIT_URL", "ws://localhost:7880")
LIVEKIT_API_KEY = os.getenv("LIVEKIT_API_KEY", "")
LIVEKIT_API_SECRET = os.getenv("LIVEKIT_API_SECRET", "")
AGENT_NAME = os.getenv("AGENT_NAME", "ai-calling-agent")
MAX_CALL_SECONDS = int(os.getenv("MAX_CALL_SECONDS", "300"))
# Optional: fallback trunk ID when client config has none (e.g. ST_MgmsF2eJdisa)
OUTBOUND_TRUNK_ID = os.getenv("OUTBOUND_TRUNK_ID", "")

# Provider defaults (env-level fallback)
DEFAULT_LLM_PROVIDER = os.getenv("DEFAULT_LLM_PROVIDER", "gemini")
DEFAULT_LLM_MODEL = os.getenv("DEFAULT_LLM_MODEL", "gemini-2.5-flash")
DEFAULT_STT_PROVIDER = os.getenv("DEFAULT_STT_PROVIDER", "deepgram")
DEFAULT_STT_MODEL = os.getenv("DEFAULT_STT_MODEL", "nova-3")
DEFAULT_TTS_PROVIDER = os.getenv("DEFAULT_TTS_PROVIDER", "deepgram")
DEFAULT_TTS_MODEL = os.getenv("DEFAULT_TTS_MODEL", "aura-2")
DEFAULT_TTS_VOICE = os.getenv("DEFAULT_TTS_VOICE", "athena")

# MongoDB - extract db name from URI or use default
_db_name = "ai_calling"
if "/" in MONGODB_URI.split("?")[0]:
    _db_name = MONGODB_URI.split("/")[-1].split("?")[0] or _db_name
mongo = MongoClient(MONGODB_URI)
db = mongo[_db_name]


def _now_iso():
    return datetime.utcnow().isoformat() + "Z"


def _digits_only(s):
    return re.sub(r"\D", "", s)


def _is_low_signal_user_text(text: str, min_words: int = 2, min_chars: int = 6) -> bool:
    """
    Heuristic filter for tiny/noisy SIP transcripts.
    Keeps analytics/summaries cleaner when background audio causes short finals.
    """
    if not text:
        return True
    t = re.sub(r"\s+", " ", text).strip()
    if len(t) < min_chars:
        return True
    words = [w for w in re.split(r"\s+", t) if w]
    return len(words) < min_words


def _normalize_phone_identity(phone: str) -> str:
    return f"sip_{_digits_only(phone) or uuid.uuid4().hex[:8]}"


def _parse_metadata(raw: str | None) -> dict | None:
    if not raw:
        return None
    try:
        return json.loads(raw)
    except Exception:
        return None


def _merge_config(override: dict | None, client: dict | None) -> dict:
    return {**(client or {}), **(override or {})}


def _provider_env_key(kind: str, provider: str) -> str | None:
    provider_key_map = {
        ("llm", "gemini"): ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
        ("llm", "openai"): ["OPENAI_API_KEY"],
        ("llm", "grok"): ["XAI_API_KEY"],
        ("llm", "xai"): ["XAI_API_KEY"],
        ("llm", "deepseek"): ["DEEPSEEK_API_KEY"],
        ("stt", "deepgram"): ["DEEPGRAM_API_KEY"],
        ("stt", "assemblyai"): ["ASSEMBLYAI_API_KEY"],
        ("stt", "sarvam"): ["SARVAM_API_KEY"],
        ("tts", "deepgram"): ["DEEPGRAM_API_KEY"],
        ("tts", "elevenlabs"): ["ELEVENLABS_API_KEY"],
        ("tts", "cartesia"): ["CARTESIA_API_KEY"],
        ("tts", "inworld"): ["INWORLD_API_KEY"],
        ("tts", "sarvam"): ["SARVAM_API_KEY"],
        ("tts", "xai"): ["XAI_API_KEY"],
        ("tts", "murf"): ["MURF_API_KEY"],
    }
    keys = provider_key_map.get((kind, provider), [])
    for key in keys:
        val = (os.getenv(key) or "").strip()
        if val:
            return val
    return None


def _resolve_runtime_config(client_cfg: dict | None, meta: dict | None) -> dict:
    """
    Resolve runtime provider config with precedence:
    1) dispatch metadata.providerConfig
    2) client config document
    3) .env defaults
    """
    payload_cfg = (meta or {}).get("providerConfig") or {}
    client_cfg = client_cfg or {}

    llm_cfg = _merge_config(payload_cfg.get("llm"), client_cfg.get("llm"))
    stt_cfg = _merge_config(payload_cfg.get("stt"), client_cfg.get("stt"))
    tts_cfg = _merge_config(payload_cfg.get("tts"), client_cfg.get("tts"))
    sip_cfg = _merge_config(payload_cfg.get("sip"), client_cfg.get("sip"))
    turn_cfg = _merge_config(
        payload_cfg.get("turnHandling") or payload_cfg.get("turn_handling"),
        client_cfg.get("turnHandling") or client_cfg.get("turn_handling"),
    )

    llm_provider = (llm_cfg.get("provider") or DEFAULT_LLM_PROVIDER).strip().lower()
    stt_provider = (stt_cfg.get("provider") or DEFAULT_STT_PROVIDER).strip().lower()
    tts_provider = (tts_cfg.get("provider") or DEFAULT_TTS_PROVIDER).strip().lower()

    resolved_llm = {
        "provider": llm_provider,
        "model": (llm_cfg.get("model") or DEFAULT_LLM_MODEL).strip(),
        "apiKey": (llm_cfg.get("apiKey") or "").strip() or _provider_env_key("llm", llm_provider) or "",
    }
    resolved_stt = {
        "provider": stt_provider,
        "model": ((stt_cfg.get("model") or DEFAULT_STT_MODEL) if stt_cfg.get("model") is not None else DEFAULT_STT_MODEL),
        "language": stt_cfg.get("language"),
        "mode": stt_cfg.get("mode"),
        "apiKey": (stt_cfg.get("apiKey") or "").strip() or _provider_env_key("stt", stt_provider) or "",
    }
    resolved_tts = {
        "provider": tts_provider,
        "model": (tts_cfg.get("model") or DEFAULT_TTS_MODEL),
        "voice": (tts_cfg.get("voice") or DEFAULT_TTS_VOICE),
        "targetLanguageCode": tts_cfg.get("targetLanguageCode") or tts_cfg.get("target_language_code"),
        "apiKey": (tts_cfg.get("apiKey") or "").strip() or _provider_env_key("tts", tts_provider) or "",
    }
    resolved_sip = {
        "provider": (sip_cfg.get("provider") or "vobiz").strip().lower(),
        "trunkId": sip_cfg.get("trunkId") or OUTBOUND_TRUNK_ID,
        "fromNumber": sip_cfg.get("fromNumber") or os.getenv("DEFAULT_FROM_NUMBER", ""),
    }
    resolved_turn_handling = {
        # Auto uses turn detector if available, else VAD-only
        "enabled": bool(turn_cfg.get("enabled", True)),
        "useTurnDetector": bool(turn_cfg.get("useTurnDetector", True)),
        "endpointing": {
            # SIP baseline: conservative to avoid false tiny turns on PSTN noise
            "mode": turn_cfg.get("endpointing", {}).get("mode", "fixed"),
            "min_delay": float(turn_cfg.get("endpointing", {}).get("min_delay", 0.9)),
            "max_delay": float(turn_cfg.get("endpointing", {}).get("max_delay", 2.2)),
        },
        "interruption": {
            "enabled": bool(turn_cfg.get("interruption", {}).get("enabled", True)),
            # Adaptive catches natural barge-ins better than strict VAD-only in many phone calls.
            "mode": turn_cfg.get("interruption", {}).get("mode", "adaptive"),
            # Lower threshold so normal speech can interrupt (not only loud speech).
            "min_duration": float(turn_cfg.get("interruption", {}).get("min_duration", 0.45)),
            # Require at least brief linguistic content before interrupting.
            "min_words": int(turn_cfg.get("interruption", {}).get("min_words", 2)),
            "false_interruption_timeout": float(
                turn_cfg.get("interruption", {}).get("false_interruption_timeout", 1.5)
            ),
            "resume_false_interruption": bool(
                turn_cfg.get("interruption", {}).get("resume_false_interruption", True)
            ),
        },
        "preemptive_generation": {
            # Disable by default to avoid noisy preemptive starts on telephony calls
            "enabled": bool(turn_cfg.get("preemptive_generation", {}).get("enabled", False)),
            "preemptive_tts": bool(turn_cfg.get("preemptive_generation", {}).get("preemptive_tts", False)),
            "max_speech_duration": float(
                turn_cfg.get("preemptive_generation", {}).get("max_speech_duration", 8.0)
            ),
            "max_retries": int(turn_cfg.get("preemptive_generation", {}).get("max_retries", 2)),
        },
        "vad": {
            # Silero defaults tuned for noisy SIP streams
            "min_speech_duration": float(turn_cfg.get("vad", {}).get("min_speech_duration", 0.10)),
            "min_silence_duration": float(turn_cfg.get("vad", {}).get("min_silence_duration", 0.8)),
            "prefix_padding_duration": float(turn_cfg.get("vad", {}).get("prefix_padding_duration", 0.4)),
            "activation_threshold": float(turn_cfg.get("vad", {}).get("activation_threshold", 0.58)),
            "sample_rate": int(turn_cfg.get("vad", {}).get("sample_rate", 16000)),
            "force_cpu": bool(turn_cfg.get("vad", {}).get("force_cpu", True)),
        },
        "noiseCancellation": {
            "enabled": bool(turn_cfg.get("noiseCancellation", {}).get("enabled", True)),
            # For SIP, BVCTelephony generally gives best suppression of competing voices/noise.
            "model": str(turn_cfg.get("noiseCancellation", {}).get("model", "BVCTelephony")),
        },
    }

    return {
        "llm": resolved_llm,
        "stt": resolved_stt,
        "tts": resolved_tts,
        "sip": resolved_sip,
        "turnHandling": resolved_turn_handling,
    }


def _build_turn_handling(turn_cfg: dict):
    """Build LiveKit turn_handling payload with optional turn detector model."""
    if not turn_cfg.get("enabled", True):
        return None

    turn_detection = "vad"
    if turn_cfg.get("useTurnDetector", True) and MultilingualModel is not None:
        try:
            turn_detection = MultilingualModel()
        except Exception:
            logging.warning("[TurnHandling] Failed to initialize turn detector, falling back to VAD")
            turn_detection = "vad"

    return {
        "turn_detection": turn_detection,
        "endpointing": turn_cfg.get("endpointing", {}),
        "interruption": turn_cfg.get("interruption", {}),
        "preemptive_generation": turn_cfg.get("preemptive_generation", {}),
    }


def _build_noise_cancellation(turn_cfg: dict):
    """
    Build noise cancellation model instance.
    Supported models: BVCTelephony, BVC, NC
    """
    nc_cfg = turn_cfg.get("noiseCancellation", {})
    if not nc_cfg.get("enabled", True):
        return None

    if noise_cancellation is None:
        logging.warning("[NoiseCancellation] Plugin not installed, continuing without filter")
        return None

    requested = (nc_cfg.get("model") or "BVCTelephony").strip()
    factories = {
        "BVCTelephony": getattr(noise_cancellation, "BVCTelephony", None),
        "BVC": getattr(noise_cancellation, "BVC", None),
        "NC": getattr(noise_cancellation, "NC", None),
    }

    # Try requested first, then graceful fallback order for SIP calls.
    fallback_order = [requested, "NC", "BVC"]
    seen = set()
    for key in fallback_order:
        if key in seen:
            continue
        seen.add(key)
        factory = factories.get(key)
        if factory is None:
            continue
        try:
            model = factory()
            if key != requested:
                logging.warning(
                    "[NoiseCancellation] Requested %s unavailable; using %s",
                    requested,
                    key,
                )
            else:
                logging.info("[NoiseCancellation] Using model %s", key)
            return model
        except Exception:
            continue

    logging.warning("[NoiseCancellation] No compatible model initialized, continuing without filter")
    return None


def _load_vad(turn_cfg: dict, ctx: JobContext | None = None):
    """Load Silero VAD, preferring prewarmed model when available."""
    if silero is None:
        logging.warning("[VAD] livekit-plugins-silero not installed, using fallback turn detection")
        return None

    if ctx is not None:
        try:
            prewarmed = getattr(getattr(ctx, "proc", None), "userdata", {}).get("vad")
            if prewarmed is not None:
                return prewarmed
        except Exception:
            pass

    try:
        return silero.VAD.load(**turn_cfg.get("vad", {}))
    except Exception as e:
        logging.warning("[VAD] Failed to load Silero VAD, continuing without explicit VAD: %s", e)
        return None


async def _close_livekit_api(livekit_api):
    """Best-effort close to avoid unclosed aiohttp session warnings."""
    if not livekit_api:
        return
    for method_name in ("aclose", "close"):
        method = getattr(livekit_api, method_name, None)
        if method is None:
            continue
        try:
            result = method()
            if inspect.isawaitable(result):
                await result
        except Exception:
            pass
        return


async def _generate_summary(
    transcript: str, summary_prompt: str, extraction_schema: dict, api_key: str | None = None
) -> tuple[str, dict]:
    """Generate summary and extracted fields using Gemini. Uses client's key if provider is gemini, else env."""
    try:
        from google import genai
        key = (api_key or "").strip() or os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY")
        if not key or key == "***":
            logging.warning("[Summarizer] No valid API key (client config or GOOGLE_API_KEY)")
            return "", {}
        client = genai.Client(api_key=key)
        prompt = f"""
You are a call analyst.

{summary_prompt}

Extraction schema (field -> meaning):
{json.dumps(extraction_schema, indent=2)}

Transcript:
{transcript}

Return strict JSON only:
{{ "summary": "concise call summary", "extracted": {{ "fieldName": "value" }} }}
"""
        r = client.models.generate_content(model=DEFAULT_LLM_MODEL, contents=prompt)
        text = (getattr(r, "text", "") or "").strip()
        cleaned = re.sub(r"^```json\s*", "", text).strip()
        cleaned = re.sub(r"\s*```$", "", cleaned).strip()
        parsed = json.loads(cleaned)
        return parsed.get("summary", ""), parsed.get("extracted", {})
    except Exception as e:
        logging.error("[Summarizer] Error: %s", e, exc_info=True)
        return "", {}


async def run_call(ctx: JobContext, meta: dict):
    """Execute a single outbound call with client-specific providers."""
    call_id = meta.get("callId")
    client_id = meta.get("clientId")
    phone = meta.get("phone")
    contact_name = meta.get("contactName") or ""
    prompt = meta.get("prompt") or "You are a professional voice assistant. Keep replies short and clear."
    summary_prompt = meta.get("summaryPrompt") or "Summarize the call."
    extraction_schema = meta.get("extractionSchema") or {}

    if not call_id or not phone:
        raise ValueError("callId and phone required in metadata")

    # Load client config from MongoDB (optional with env fallback)
    config = db.client_configs.find_one({"client_id": client_id}) if client_id else {}
    runtime_cfg = _resolve_runtime_config(config, meta)

    llm_cfg = runtime_cfg.get("llm", {})
    stt_cfg = runtime_cfg.get("stt", {})
    tts_cfg = runtime_cfg.get("tts", {})
    sip_cfg = runtime_cfg.get("sip", {})
    turn_cfg = runtime_cfg.get("turnHandling", {})

    # Build agent with client-specific providers
    llm = get_llm(llm_cfg["provider"], llm_cfg.get("apiKey"), llm_cfg.get("model", ""))
    stt = get_stt(
        stt_cfg["provider"],
        stt_cfg.get("apiKey"),
        stt_cfg.get("model"),
        stt_cfg.get("language"),
        stt_cfg.get("mode"),
    )
    tts = get_tts(
        tts_cfg["provider"],
        tts_cfg.get("apiKey"),
        tts_cfg.get("voice", "default"),
        tts_cfg.get("model"),
        tts_cfg.get("targetLanguageCode") or tts_cfg.get("target_language_code"),
    )

    agent = Agent(instructions=prompt, stt=stt, llm=llm, tts=tts)

    transcript_lines = []
    transcript_coll = db.transcript_entries
    calls_coll = db.calls

    def on_user_transcribed(ev):
        # Ignore tiny/noisy final snippets in transcript storage to reduce summary pollution.
        if getattr(ev, "is_final", False) and _is_low_signal_user_text(getattr(ev, "transcript", "") or ""):
            logging.debug("[Transcript] Ignored low-signal user final transcript: %r", ev.transcript)
            return
        entry = {"role": "user", "text": ev.transcript, "is_final": ev.is_final, "created_at": _now_iso()}
        transcript_lines.append(entry)
        transcript_coll.insert_one({
            "call_id": call_id,
            "role": "user",
            "text": ev.transcript,
            "is_final": ev.is_final,
            "created_at": entry["created_at"],
        })

    def on_conversation_item(ev):
        item = getattr(ev, "item", None) or {}
        role = getattr(item, "role", "") or ""
        text = getattr(item, "text_content", "") or getattr(item, "text", "") or ""
        if not text or role not in ("assistant", "agent"):
            return
        entry = {"role": "assistant", "text": text, "is_final": True, "created_at": _now_iso()}
        transcript_lines.append(entry)
        transcript_coll.insert_one({
            "call_id": call_id,
            "role": "assistant",
            "text": text,
            "is_final": True,
            "created_at": entry["created_at"],
        })

    vad = _load_vad(turn_cfg, ctx=ctx)

    turn_handling = _build_turn_handling(turn_cfg)
    session_kwargs = {}
    if vad is not None:
        session_kwargs["vad"] = vad
    if turn_handling is not None:
        session_kwargs["turn_handling"] = turn_handling

    session = AgentSession(**session_kwargs)
    session.on("user_input_transcribed", on_user_transcribed)
    session.on("conversation_item_added", on_conversation_item)

    await ctx.connect()
    room_options = None
    noise_filter = _build_noise_cancellation(turn_cfg)
    if noise_filter is not None:
        room_options = room_io.RoomOptions(
            audio_input=room_io.AudioInputOptions(noise_cancellation=noise_filter)
        )

    await session.start(room=ctx.room, agent=agent, room_options=room_options)

    # Update status to in-progress
    calls_coll.update_one(
        {"id": call_id},
        {"$set": {"status": "in-progress", "updated_at": _now_iso()}},
    )

    # Place SIP call
    trunk_id = sip_cfg.get("trunkId", "") or OUTBOUND_TRUNK_ID
    from_number = sip_cfg.get("fromNumber", "")
    if not trunk_id:
        raise ValueError(
            "SIP trunkId required. Set it in Dashboard → Client → Config → SIP → Trunk ID, "
            "or set OUTBOUND_TRUNK_ID in .env (e.g. ST_MgmsF2eJdisa). See docs/SIP.md"
        )

    livekit_api = LiveKitAPI(
        LIVEKIT_URL.replace("ws://", "http://").replace("wss://", "https://"),
        LIVEKIT_API_KEY,
        LIVEKIT_API_SECRET,
    )
    participant_identity = _normalize_phone_identity(phone)
    req_kw = dict(
        sip_trunk_id=trunk_id,
        sip_call_to=phone,
        room_name=ctx.room.name,
        participant_identity=participant_identity,
        participant_name=contact_name or phone,
        wait_until_answered=True,
        max_call_duration=timedelta(seconds=MAX_CALL_SECONDS),
    )
    if from_number:
        req_kw["sip_number"] = from_number
    req = CreateSIPParticipantRequest(**req_kw)
    try:
        await livekit_api.sip.create_sip_participant(req)
    finally:
        await _close_livekit_api(livekit_api)

    # Greet
    await session.generate_reply(
        instructions=f"The callee just answered. Greet {contact_name or 'the user'} briefly and start the conversation."
    )

    # Wait until SIP participant disconnects or max duration
    done = asyncio.Event()
    def on_disconnect(participant):
        if getattr(participant, "identity", None) == participant_identity:
            done.set()
    ctx.room.on("participant_disconnected", on_disconnect)
    try:
        await asyncio.wait_for(done.wait(), timeout=MAX_CALL_SECONDS)
    except (asyncio.TimeoutError, asyncio.CancelledError):
        # Call ended (timeout or user hung up) - still generate summary from transcript
        logging.info("[run_call] Call ended (timeout or disconnect), generating summary from transcript")

    # Build transcript text
    transcript_text = "\n".join(
        f"{e['role']}: {e['text']}" for e in transcript_lines if e.get("is_final") and (e.get("text") or "").strip()
    )

    summary = ""
    extracted = {}
    error_text = None
    summary_api_key = None
    if llm_cfg.get("provider") == "gemini" and (llm_cfg.get("apiKey") or "").strip() and llm_cfg.get("apiKey") != "***":
        summary_api_key = llm_cfg.get("apiKey")
    if transcript_text.strip():
        try:
            summary, extracted = await _generate_summary(
                transcript_text, summary_prompt, extraction_schema, api_key=summary_api_key
            )
        except Exception as e:
            error_text = str(e)

    calls_coll.update_one(
        {"id": call_id},
        {
            "$set": {
                "status": "completed",
                "transcript": transcript_text,
                "summary": summary,
                "extracted_fields": extracted,
                "error": error_text,
                "updated_at": _now_iso(),
            }
        },
    )


async def entrypoint(ctx: JobContext):
    """Agent entry point - parse metadata and run call."""
    meta = _parse_metadata(ctx.job.metadata if hasattr(ctx.job, "metadata") else None)
    if not meta or not meta.get("callId") or not meta.get("phone"):
        raise ValueError("Dispatch metadata must include callId and phone.")
    await run_call(ctx, meta)


def prewarm(proc):
    """Preload VAD weights once per worker process."""
    if silero is None:
        return
    try:
        proc.userdata["vad"] = silero.VAD.load()
    except Exception as e:
        logging.warning("[VAD] Prewarm failed, runtime load will be used: %s", e)


if __name__ == "__main__":
    cli.run_app(WorkerOptions(agent_name=AGENT_NAME, entrypoint_fnc=entrypoint, prewarm_fnc=prewarm))

"""Resolve effective LLM/STT/TTS configuration from dispatch metadata + env.

Resolution precedence (highest first):
1. ``providerConfig.<kind>`` from the dispatch payload (model, voice, apiKey…).
2. Provider-specific environment fallback API key (e.g. ``OPENAI_API_KEY``).
3. Application-wide defaults from :class:`app.config.Settings`.
"""

from __future__ import annotations

import os

from .config import Settings, settings as default_settings

# Maps (kind, provider) → ordered list of env vars to try as fallback API key.
_PROVIDER_ENV_KEYS: dict[tuple[str, str], list[str]] = {
    ("llm", "gemini"): ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    ("llm", "openai"): ["OPENAI_API_KEY"],
    ("llm", "grok"): ["XAI_API_KEY"],
    ("llm", "xai"): ["XAI_API_KEY"],
    ("llm", "deepseek"): ["DEEPSEEK_API_KEY"],
    ("stt", "deepgram"): ["DEEPGRAM_API_KEY"],
    ("stt", "assemblyai"): ["ASSEMBLYAI_API_KEY"],
    ("tts", "deepgram"): ["DEEPGRAM_API_KEY"],
    ("tts", "elevenlabs"): ["ELEVENLABS_API_KEY"],
    ("tts", "cartesia"): ["CARTESIA_API_KEY"],
    ("tts", "xai"): ["XAI_API_KEY"],
    ("tts", "murf"): ["MURF_API_KEY"],
}


def clean_api_key(value: str | None) -> str:
    """Trim whitespace and treat the masked literal ``***`` as missing."""
    v = (value or "").strip()
    if not v or v == "***":
        return ""
    return v


def provider_key(kind: str, provider: str) -> str | None:
    """Look up the first non-empty env var registered for ``(kind, provider)``."""
    for env_name in _PROVIDER_ENV_KEYS.get((kind, provider), []):
        value = (os.getenv(env_name) or "").strip()
        if value:
            return value
    return None


def _resolve_api_key(kind: str, provider: str, payload_key: str | None) -> str:
    return clean_api_key(payload_key) or provider_key(kind, provider) or ""


def resolve_provider_cfg(meta: dict, settings: Settings | None = None) -> dict:
    """Build the effective provider config dict consumed by ``providers/`` factories.

    The shape mirrors the original entrypoint exactly: top-level keys are
    ``llm`` / ``stt`` / ``tts``, each containing the resolved provider name,
    model, optional voice/language fields and a final ``api_key``.
    """
    cfg = (meta.get("providerConfig") or {}) if isinstance(meta, dict) else {}
    llm = cfg.get("llm") or {}
    stt = cfg.get("stt") or {}
    tts = cfg.get("tts") or {}

    defaults = (settings or default_settings).providers

    llm_provider = (llm.get("provider") or defaults.llm_provider).lower()
    stt_provider = (stt.get("provider") or defaults.stt_provider).lower()
    tts_provider = (tts.get("provider") or defaults.tts_provider).lower()

    return {
        "llm": {
            "provider": llm_provider,
            "model": llm.get("model") or defaults.llm_model,
            "api_key": _resolve_api_key("llm", llm_provider, llm.get("apiKey")),
        },
        "stt": {
            "provider": stt_provider,
            "model": stt.get("model") or defaults.stt_model,
            "language": stt.get("language"),
            "mode": stt.get("mode"),
            "api_key": _resolve_api_key("stt", stt_provider, stt.get("apiKey")),
        },
        "tts": {
            "provider": tts_provider,
            "model": tts.get("model") or defaults.tts_model,
            "voice": tts.get("voice") or defaults.tts_voice,
            "target_language_code": tts.get("targetLanguageCode"),
            "api_key": _resolve_api_key("tts", tts_provider, tts.get("apiKey")),
        },
    }


__all__ = ["clean_api_key", "provider_key", "resolve_provider_cfg"]

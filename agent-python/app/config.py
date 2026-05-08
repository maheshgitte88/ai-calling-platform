"""Application configuration loaded from environment variables.

A single immutable :class:`Settings` instance is exposed via :data:`settings`
so the rest of the app never reaches into ``os.environ`` directly. All
defaults match the previous monolithic entrypoint to preserve behaviour.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(dotenv_path=_ROOT / ".env")

_TRUTHY = {"1", "true", "yes", "on"}


def _bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in _TRUTHY


def _str(name: str, default: str = "") -> str:
    return (os.getenv(name) or default).strip()


@dataclass(frozen=True)
class ProviderDefaults:
    """Default LLM / STT / TTS provider selection (used as the lowest fallback)."""

    llm_provider: str
    llm_model: str
    stt_provider: str
    stt_model: str
    tts_provider: str
    tts_model: str
    tts_voice: str


@dataclass(frozen=True)
class AvatarSettings:
    """Optional virtual-avatar (Simli) configuration."""

    enabled: bool
    provider: str
    simli_api_key: str
    simli_face_id: str
    simli_emotion_id: str


@dataclass(frozen=True)
class Settings:
    """Top-level runtime configuration."""

    mongodb_uri: str
    agent_name: str
    providers: ProviderDefaults
    avatar: AvatarSettings

    @property
    def mongodb_database(self) -> str:
        """Database name parsed out of the Mongo URI (defaults to ``ai_calling``)."""
        return self.mongodb_uri.split("/")[-1].split("?")[0] or "ai_calling"


def load_settings() -> Settings:
    return Settings(
        mongodb_uri=_str("MONGODB_URI", "mongodb://localhost:27017/ai_calling"),
        agent_name=_str("INTERVIEW_AGENT_NAME") or _str("AGENT_NAME", "ai-interview-agent"),
        providers=ProviderDefaults(
            llm_provider=_str("DEFAULT_LLM_PROVIDER", "openai"),
            llm_model=_str("DEFAULT_LLM_MODEL", "gpt-4o-mini"),
            stt_provider=_str("DEFAULT_STT_PROVIDER", "deepgram"),
            stt_model=_str("DEFAULT_STT_MODEL", "nova-3"),
            tts_provider=_str("DEFAULT_TTS_PROVIDER", "deepgram"),
            tts_model=_str("DEFAULT_TTS_MODEL", "aura-asteria-en"),
            tts_voice=_str("DEFAULT_TTS_VOICE", "athena"),
        ),
        avatar=AvatarSettings(
            enabled=_bool("ENABLE_AVATAR", False),
            provider=_str("AVATAR_PROVIDER", "simli").lower(),
            simli_api_key=_str("SIMLI_API_KEY"),
            simli_face_id=_str("SIMLI_FACE_ID"),
            simli_emotion_id=_str("SIMLI_EMOTION_ID"),
        ),
    )


settings: Settings = load_settings()

__all__ = ["Settings", "ProviderDefaults", "AvatarSettings", "load_settings", "settings"]

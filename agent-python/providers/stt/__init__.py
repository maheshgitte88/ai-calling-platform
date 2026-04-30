"""
STT provider factory - creates LiveKit STT instances from client config.
Models verified against livekit-plugins-deepgram, assemblyai, sarvam.
"""

import os

from livekit.plugins import deepgram, assemblyai, sarvam

# AssemblyAI plugin: universal-streaming-english, universal-streaming-multilingual, u3-rt-pro
_VALID_ASSEMBLYAI = {"u3-rt-pro", "universal-streaming-english", "universal-streaming-multilingual"}
# Sarvam STT: saaras:v3, saaras:v2.5, saarika:v2.5
_VALID_SARVAM_MODES = {"transcribe", "translate", "verbatim", "translit", "codemix"}


def get_stt(provider: str, api_key: str, model: str = None, language: str = None, mode: str = None):
    """Return LiveKit STT for given provider."""
    if provider == "deepgram":
        return deepgram.STT(api_key=api_key, model=model or "nova-3")
    if provider == "assemblyai":
        m = model or "universal-streaming-english"
        if m not in _VALID_ASSEMBLYAI:
            m = "universal-streaming-english"
        return assemblyai.STT(api_key=api_key, model=m)
    if provider == "sarvam":
        key = (api_key or "").strip() or os.getenv("SARVAM_API_KEY")
        kwargs = {"api_key": key, "model": model or "saaras:v3"}
        if language:
            kwargs["language"] = language
        if mode and mode in _VALID_SARVAM_MODES:
            kwargs["mode"] = mode
        return sarvam.STT(**kwargs)
    raise ValueError(f"Unknown STT provider: {provider}")

"""
TTS provider factory - creates LiveKit TTS instances from client config.
Supports: ElevenLabs, Cartesia, Deepgram (Aura), INWORLD, Sarvam.
Voice: ElevenLabs/Cartesia use voice_id (UUID or name), Deepgram/INWORLD/Sarvam use voice/speaker name.
"""

import os

from livekit.plugins import elevenlabs, cartesia, deepgram, inworld, sarvam, xai


def get_tts(provider: str, api_key: str, voice: str, model: str = None, target_language_code: str = None):
    """Return LiveKit TTS for given provider. Voice format varies by provider."""
    if provider == "elevenlabs":
        return elevenlabs.TTS(
            api_key=api_key,
            voice_id=voice or "Rachel",
            model_id=model or "eleven_turbo_v2_5",
        )
    if provider == "cartesia":
        # Cartesia uses sonic-3 (not sonic-3-stable); map dashboard values to valid API ids
        _model = (model or "sonic-english").strip()
        if _model in ("sonic-3-stable", "sonic-3"):
            _model = "sonic-3"
        elif _model == "sonic-3-latest":
            _model = "sonic-3-latest"  # valid beta model
        return cartesia.TTS(
            api_key=api_key,
            voice=voice or "f786b574-daa5-4673-aa0c-cbe3e8534c02",
            model=_model,
        )
    if provider == "deepgram":
        # Deepgram model compatibility varies by account/plugin version.
        # Normalize to a broadly supported legacy model when needed.
        resolved_model = (model or "aura-asteria-en").strip()
        if resolved_model == "aura-2":
            resolved_model = "aura-asteria-en"
        kwargs = {
            "api_key": api_key,
            "model": resolved_model,
            "voice": voice or "athena",
        }
        try:
            return deepgram.TTS(**kwargs)
        except TypeError:
            # Compatibility fallback for plugin versions where `voice` is unsupported.
            kwargs.pop("voice", None)
            return deepgram.TTS(**kwargs)
    if provider == "inworld":
        return inworld.TTS(
            api_key=api_key,
            voice=voice or "Arjun",
            model=model or "inworld-tts-1.5-mini",
        )
    if provider == "xai":
        key = (api_key or "").strip() or os.getenv("XAI_API_KEY")
        return xai.TTS(
            api_key=key,
            voice=voice or "ara",
            language=target_language_code or "auto",
        )
    if provider == "sarvam":
        key = (api_key or "").strip() or os.getenv("SARVAM_API_KEY")
        kwargs = {
            "api_key": key,
            "model": model or "bulbul:v3",
            "speaker": voice or "shubh",
            "target_language_code": target_language_code or "hi-IN",
        }
        return sarvam.TTS(**kwargs)
    raise ValueError(f"Unknown TTS provider: {provider}")

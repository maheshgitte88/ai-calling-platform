"""LLM provider factory - creates LiveKit LLM instances from client config."""

import os
from livekit.plugins import openai, google, xai

_PROVIDERS = {
    "gemini": lambda cfg: google.LLM(
        model=cfg.get("model", "gemini-2.5-flash"),
        api_key=(cfg.get("apiKey") or "").strip() or os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY"),
    ),
    "openai": lambda cfg: openai.LLM(
        model=cfg.get("model", "gpt-4o-mini"),
        api_key=(cfg.get("apiKey") or "").strip() or os.getenv("OPENAI_API_KEY"),
    ),
    "grok": lambda cfg: xai.responses.LLM(
        model=cfg.get("model", "grok-4-1-fast-non-reasoning"),
        api_key=(cfg.get("apiKey") or "").strip() or os.getenv("XAI_API_KEY"),
    ),
    "xai": lambda cfg: xai.responses.LLM(
        model=cfg.get("model", "grok-4-1-fast-non-reasoning"),
        api_key=(cfg.get("apiKey") or "").strip() or os.getenv("XAI_API_KEY"),
    ),
    "deepseek": lambda cfg: openai.LLM(
        model=cfg.get("model", "deepseek-chat"),
        api_key=(cfg.get("apiKey") or "").strip() or os.getenv("DEEPSEEK_API_KEY"),
        base_url="https://api.deepseek.com/v1",
    ),
}


def get_llm(provider: str, api_key: str | None, model: str):
    """Return LiveKit LLM for given provider."""
    cfg = {"apiKey": api_key, "model": model}
    fn = _PROVIDERS.get(provider)
    if not fn:
        raise ValueError(f"Unknown LLM provider: {provider}")
    return fn(cfg)

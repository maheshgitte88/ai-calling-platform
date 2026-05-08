"""Interview agent application package.

Modules:
- config: env-derived settings (single source of truth)
- logging_setup: shared logging configuration
- db: MongoDB accessor (lazy)
- time_utils: small time helpers
- metadata: dispatch-metadata parsing + duration math
- skills: skill spec normalization
- prompt: system prompt builder + base instructions
- provider_resolver: payload/env → effective LLM/STT/TTS config
- transcript: in-memory + Mongo transcript recorder
- avatar: optional Simli avatar attachment
- evaluation: post-interview structured evaluation (LLM JSON)
- runner: end-to-end interview session orchestration + worker entrypoint
"""

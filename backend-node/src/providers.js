/**
 * Provider metadata for LLM, STT, TTS, SIP.
 * Based on LiveKit plugin docs and official provider pricing.
 * Models/voices verified for livekit-plugins-* compatibility.
 *
 * Pricing refs:
 * - Gemini: https://ai.google.dev/gemini-api/docs/pricing
 * - OpenAI: https://openai.com/api/pricing/
 * - AssemblyAI: https://www.assemblyai.com/docs/getting-started/models
 * - xAI Grok: https://docs.x.ai/developers/models
 * - DeepSeek: https://api-docs.deepseek.com/quick_start/pricing
 */

export const LLM_PROVIDERS = [
  {
    id: "gemini",
    name: "Google Gemini",
    models: [
      { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash (recommended default)", priceIn: 0.3, priceOut: 2.5 },
      { id: "gemini-2.5-flash-lite", name: "Gemini 2.5 Flash Lite", priceIn: 0.1, priceOut: 0.4 },
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", priceIn: 1.25, priceOut: 10 },
      { id: "gemini-3-flash-preview", name: "Gemini 3 Flash Preview", priceIn: 0.5, priceOut: 3 },
      { id: "gemini-3.1-flash-lite-preview", name: "Gemini 3.1 Flash Lite Preview", priceIn: 0.25, priceOut: 1.5 },
      { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash", priceIn: 0.1, priceOut: 0.4 },
      { id: "gemini-1.5-pro", name: "Gemini 1.5 Pro", priceIn: 1.25, priceOut: 5 },
      { id: "gemini-1.5-flash", name: "Gemini 1.5 Flash", priceIn: 0.075, priceOut: 0.3 },
    ],
    priceUnit: "per 1M tokens",
  },
  {
    id: "openai",
    name: "OpenAI",
    models: [
      { id: "gpt-4o-mini", name: "GPT-4o Mini", priceIn: 0.15, priceOut: 0.6 },
      { id: "gpt-4o", name: "GPT-4o", priceIn: 2.5, priceOut: 10 },
      { id: "gpt-4-turbo", name: "GPT-4 Turbo", priceIn: 10, priceOut: 30 },
    ],
    priceUnit: "per 1M tokens",
  },
  {
    id: "grok",
    name: "Grok (xAI)",
    models: [
      { id: "grok-4-1-fast-reasoning", name: "Grok 4.1 Fast Reasoning", priceIn: 0.2, priceOut: 0.5 },
      { id: "grok-4-1-fast-non-reasoning", name: "Grok 4.1 Fast Non-Reasoning", priceIn: 0.2, priceOut: 0.5 },
      { id: "grok-4.20-0309-reasoning", name: "Grok 4.20 Reasoning", priceIn: 2, priceOut: 6 },
      { id: "grok-2", name: "Grok 2 (legacy)", priceIn: 0.2, priceOut: 0.5 },
    ],
    priceUnit: "per 1M tokens",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    models: [
      { id: "deepseek-chat", name: "DeepSeek Chat (V3.2)", priceIn: 0.28, priceOut: 0.42 },
      { id: "deepseek-reasoner", name: "DeepSeek Reasoner (V3.2)", priceIn: 0.28, priceOut: 0.42 },
    ],
    priceUnit: "per 1M tokens",
  },
];

export const STT_PROVIDERS = [
  {
    id: "deepgram",
    name: "Deepgram",
    models: [
      { id: "nova-3", name: "Nova 3", pricePerMin: 0.0043 },
      { id: "nova-2", name: "Nova 2", pricePerMin: 0.0043 },
      { id: "nova", name: "Nova", pricePerMin: 0.0043 },
      { id: "base", name: "Base", pricePerMin: 0.0043 },
    ],
    priceUnit: "per min",
    voiceHint: null,
  },
  {
    id: "assemblyai",
    name: "AssemblyAI",
    models: [
      { id: "u3-rt-pro", name: "Universal-3 Pro Streaming ($0.45/hr)", pricePerMin: 0.0075 },
      { id: "universal-streaming-english", name: "Universal-Streaming English ($0.15/hr)", pricePerMin: 0.0025 },
      { id: "universal-streaming-multilingual", name: "Universal-Streaming Multilingual ($0.15/hr)", pricePerMin: 0.0025 },
    ],
    priceUnit: "per min",
    voiceHint: null,
  },
  {
    id: "sarvam",
    name: "Sarvam AI",
    models: [
      { id: "saaras:v3", name: "Saaras v3 (recommended)" },
      { id: "saaras:v2.5", name: "Saaras v2.5" },
      { id: "saarika:v2.5", name: "Saarika v2.5" },
    ],
    priceUnit: "per min",
    voiceHint: null,
    languageHint: "e.g. en-IN, hi-IN",
    modes: [
      { id: "transcribe", name: "Transcribe" },
      { id: "translate", name: "Translate" },
      { id: "verbatim", name: "Verbatim" },
      { id: "translit", name: "Translit" },
      { id: "codemix", name: "Codemix" },
    ],
  },
];

export const TTS_PROVIDERS = [
  {
    id: "elevenlabs",
    name: "ElevenLabs",
    models: [
      { id: "eleven_turbo_v2_5", name: "Turbo v2.5" },
      { id: "eleven_multilingual_v2", name: "Multilingual v2" },
    ],
    voices: [
      { id: "Rachel", name: "Rachel" },
      { id: "Domi", name: "Domi" },
      { id: "Bella", name: "Bella" },
      { id: "Antoni", name: "Antoni" },
      { id: "Elli", name: "Elli" },
      { id: "Josh", name: "Josh" },
    ],
    voiceHint: "Use voice name or paste voice_id (UUID) from ElevenLabs dashboard",
  },
  {
    id: "cartesia",
    name: "Cartesia AI",
    models: [
      { id: "sonic-english", name: "Sonic English" },
      { id: "sonic", name: "Sonic" },
      { id: "sonic-turbo", name: "Sonic Turbo" },
      { id: "sonic-2", name: "Sonic 2.0" },
      { id: "sonic-3", name: "Sonic 3.0" },
      { id: "sonic-3-2026-01-12", name: "Sonic 3.0 (2026-01-12)" },
      { id: "sonic-3-latest", name: "Sonic 3.0 Latest (beta)" },
    ],
    voices: [],
    voiceHint: "Paste voice_id (UUID) from Cartesia - e.g. 791d5162-d5eb-40f0-8189-f19db44611d8 for Ayush",
  },
  {
    id: "deepgram",
    name: "Deepgram TTS (Aura)",
    models: [
      { id: "aura-asteria-en", name: "Aura Asteria (legacy)" },
      { id: "aura", name: "Aura" },
      { id: "aura-2", name: "Aura 2" },
    ],
    voices: [
      { id: "apollo", name: "Apollo (male, en-US)" },
      { id: "athena", name: "Athena (female, en-US)" },
      { id: "odysseus", name: "Odysseus (male, en-US)" },
      { id: "theia", name: "Theia (female, en-AU)" },
      { id: "asteria", name: "Asteria (female)" },
      { id: "hera", name: "Hera (female)" },
      { id: "zeus", name: "Zeus (male)" },
    ],
    voiceHint: "Aura 2 voices: apollo, athena, odysseus, theia",
  },
  {
    id: "inworld",
    name: "Inworld",
    models: [
      { id: "inworld-tts-1.5-mini", name: "Inworld TTS 1.5 Mini" },
      { id: "inworld-tts-1.5-max", name: "Inworld TTS 1.5 Max" },
      { id: "inworld-tts-1", name: "Inworld TTS 1" },
      { id: "inworld-tts-1-max", name: "Inworld TTS 1 Max" },
    ],
    voices: [
      { id: "Arjun", name: "Arjun" },
      { id: "Ashley", name: "Ashley" },
      { id: "Diego", name: "Diego" },
      { id: "Edward", name: "Edward" },
      { id: "Hades", name: "Hades" },
      { id: "Liam", name: "Liam" },
      { id: "Anjali", name: "Anjali" },
      { id: "Priya", name: "Priya" },
      { id: "Saanvi", name: "Saanvi" },
    ],
    voiceHint: "Voice name from Inworld - Arjun, Ashley, Diego, etc.",
  },
  {
    id: "xai",
    name: "xAI (Grok TTS)",
    models: [{ id: "tts-1", name: "TTS 1" }],
    voices: [
      { id: "ara", name: "Ara (warm, friendly)" },
      { id: "eve", name: "Eve (energetic, upbeat)" },
      { id: "rex", name: "Rex (confident, clear)" },
      { id: "sal", name: "Sal (smooth, balanced)" },
      { id: "leo", name: "Leo (authoritative)" },
    ],
    voiceHint: "Voice: ara, eve, rex, sal, leo. XAI_API_KEY from console.x.ai",
  },
  {
    id: "murf",
    name: "Murf AI",
    models: [
      { id: "FALCON", name: "FALCON (default)" },
      { id: "GEN2", name: "GEN2" },
    ],
    voices: [
      { id: "en-US-matthew", name: "Matthew (en-US)" },
    ],
    voiceHint: "Use Murf voice ID format {locale}-{name}, e.g. en-US-matthew. Set MURF_API_KEY.",
  },
  {
    id: "sarvam",
    name: "Sarvam AI",
    models: [
      { id: "bulbul:v3", name: "Bulbul v3" },
      { id: "bulbul:v3-beta", name: "Bulbul v3 Beta" },
      { id: "bulbul:v2", name: "Bulbul v2" },
    ],
    voices: [
      { id: "shubh", name: "Shubh (default v3)" },
      { id: "anushka", name: "Anushka (v2)" },
      { id: "aditya", name: "Aditya" },
      { id: "ritu", name: "Ritu" },
      { id: "priya", name: "Priya" },
      { id: "neha", name: "Neha" },
      { id: "rahul", name: "Rahul" },
      { id: "abhilash", name: "Abhilash (v2)" },
      { id: "manisha", name: "Manisha (v2)" },
      { id: "vidya", name: "Vidya (v2)" },
    ],
    voiceHint: "Speaker: shubh (v3), anushka (v2). See docs.sarvam.ai",
    languageHint: "Target language: hi-IN, en-IN, ta-IN, etc.",
  },
];

export const SIP_PROVIDERS = [
  { id: "vobiz", name: "Vobiz (Default)", pricePerMin: 0.01 },
  { id: "vonage", name: "Vonage SIP", pricePerMin: 0.012 },
];

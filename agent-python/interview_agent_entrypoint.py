"""
LiveKit Video Interview Agent entrypoint.
Used for candidate-side room interviews.
"""

import asyncio
import json
import logging
import os
from datetime import datetime
from uuid import uuid4

from dotenv import load_dotenv
from livekit.agents import AgentSession, JobContext, WorkerOptions, cli, room_io
from livekit.agents.voice import Agent
from pymongo import MongoClient

from interview_evaluation import generate_structured_evaluation
from providers.llm import get_llm
from providers.stt import get_stt
from providers.tts import get_tts

load_dotenv()

logging.getLogger("pymongo").setLevel(logging.WARNING)
logging.getLogger("urllib3").setLevel(logging.WARNING)
logging.getLogger("asyncio").setLevel(logging.WARNING)
logging.getLogger("livekit.agents").setLevel(logging.INFO)
logging.getLogger("livekit").setLevel(logging.INFO)

MONGODB_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017/ai_calling")
AGENT_NAME = os.getenv("INTERVIEW_AGENT_NAME", os.getenv("AGENT_NAME", "ai-interview-agent"))
DEFAULT_LLM_PROVIDER = os.getenv("DEFAULT_LLM_PROVIDER", "openai")
DEFAULT_LLM_MODEL = os.getenv("DEFAULT_LLM_MODEL", "gpt-4o-mini")
DEFAULT_STT_PROVIDER = os.getenv("DEFAULT_STT_PROVIDER", "deepgram")
DEFAULT_STT_MODEL = os.getenv("DEFAULT_STT_MODEL", "nova-3")
DEFAULT_TTS_PROVIDER = os.getenv("DEFAULT_TTS_PROVIDER", "deepgram")
DEFAULT_TTS_MODEL = os.getenv("DEFAULT_TTS_MODEL", "aura-asteria-en")
DEFAULT_TTS_VOICE = os.getenv("DEFAULT_TTS_VOICE", "athena")
ENABLE_AVATAR = os.getenv("ENABLE_AVATAR", "false").strip().lower() in {"1", "true", "yes", "on"}
AVATAR_PROVIDER = os.getenv("AVATAR_PROVIDER", "simli").strip().lower()
SIMLI_API_KEY = os.getenv("SIMLI_API_KEY", "").strip()
SIMLI_FACE_ID = os.getenv("SIMLI_FACE_ID", "").strip()
SIMLI_EMOTION_ID = os.getenv("SIMLI_EMOTION_ID", "").strip()

try:
    from livekit.plugins import simli
except Exception:  # pragma: no cover - optional plugin
    simli = None

mongo = MongoClient(MONGODB_URI)
db = mongo[MONGODB_URI.split("/")[-1].split("?")[0] or "ai_calling"]


def now_iso() -> str:
    return datetime.utcnow().isoformat() + "Z"


def parse_metadata(raw: str | None) -> dict:
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except Exception:
        return {}


def provider_key(kind: str, provider: str) -> str | None:
    provider_key_map = {
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
    }
    for key in provider_key_map.get((kind, provider), []):
        value = (os.getenv(key) or "").strip()
        if value:
            return value
    return None


INTERVIEW_AGENT_DEFAULT_INSTRUCTIONS = """
You are a professional AI interviewer conducting a structured live interview.

Core behavior (always follow):
- Keep tone professional, fair, and encouraging.
- After a short greeting, move to substantive questions aligned with the job description and any prepared question list.
- Ask one clear question at a time; listen to the full answer before the next question.
- Use brief follow-ups only to clarify, probe depth, or when the answer is incomplete.
- Keep your spoken lines concise for real-time voice.
- Close politely when the session ends or the candidate leaves.

If a numbered "Prepared questions" list is present, you MUST work through it in order (you may add short follow-ups). If time is short, prioritize the remaining prepared questions. If there is no list, derive questions from the JD, must-ask topics, and the candidate profile.

Language: conduct the interview primarily in the Primary language. If the candidate switches language, respond within Supported languages when reasonable.
""".strip()


def build_prompt(meta: dict) -> str:
    candidate = meta.get("candidateProfile") or {}
    interview_meta = meta.get("interviewMeta") or {}
    jd = meta.get("jd") or {}
    must_ask_topics = interview_meta.get("mustAskTopics") or []
    topic_text = ", ".join(must_ask_topics) if must_ask_topics else "(none specified — infer from JD)"
    primary_language = interview_meta.get("language", "en")
    title = interview_meta.get("title", "AI interview")

    lp_raw = interview_meta.get("languagePolicy")
    if isinstance(lp_raw, str) and lp_raw.strip():
        language_policy = [x.strip().lower() for x in lp_raw.replace(";", ",").split(",") if x.strip()]
    elif isinstance(lp_raw, list) and lp_raw:
        language_policy = [str(x).strip().lower() for x in lp_raw if str(x).strip()]
    else:
        language_policy = [str(primary_language).strip().lower() or "en"]

    extra_instructions = (
        interview_meta.get("instructionsAdditional")
        or interview_meta.get("instructions")
        or ""
    ).strip()

    prepared_questions = interview_meta.get("questions") or []
    if prepared_questions and not isinstance(prepared_questions, list):
        prepared_questions = []

    lines: list[str] = [INTERVIEW_AGENT_DEFAULT_INSTRUCTIONS, ""]

    if extra_instructions:
        lines.append("Additional instructions from the employer (apply together with the defaults above):")
        lines.append(extra_instructions)
        lines.append("")

    lines.append(f"Interview title: {title}")
    lines.append(f"Primary language: {primary_language}")
    lines.append(f"Supported languages (language policy): {', '.join(language_policy)}")
    lines.append("")

    cand_name = candidate.get("name") or "the candidate"
    lines.append(f"Candidate name: {cand_name}")
    if candidate.get("email"):
        lines.append(f"Candidate email (reference): {candidate.get('email')}")
    ye = candidate.get("yearsExperience")
    if ye is not None and ye != "":
        lines.append(f"Years of experience (reference): {ye}")
    skills = candidate.get("skills") or []
    if skills:
        lines.append(f"Candidate skills (reference): {', '.join(str(s) for s in skills)}")
    lines.append("")

    lines.append("Job description / role context (use for questioning and context):")
    if jd.get("title"):
        lines.append(f"Role title: {jd.get('title')}")
    jd_body = (jd.get("text") or jd.get("summary") or "").strip()
    if jd_body:
        if len(jd_body) > 8000:
            jd_body = jd_body[:8000] + "\n[truncated]"
        lines.append(jd_body)
    else:
        lines.append("(No JD body supplied — rely on title, topics, and prepared questions.)")
    lines.append("")

    lines.append(f"Must-ask topic areas: {topic_text}")
    lines.append("")

    if prepared_questions:
        lines.append("Prepared questions (ask in this order, one at a time):")
        for i, q in enumerate(prepared_questions, start=1):
            lines.append(f"  {i}. {q}")
        lines.append("")
    else:
        lines.append(
            "No fixed prepared question list — generate appropriate questions from the JD, topics, and candidate profile."
        )
        lines.append("")

    return "\n".join(lines)


def resolve_provider_cfg(meta: dict) -> dict:
    provider_cfg = meta.get("providerConfig") or {}
    llm = provider_cfg.get("llm") or {}
    stt = provider_cfg.get("stt") or {}
    tts = provider_cfg.get("tts") or {}

    llm_provider = (llm.get("provider") or DEFAULT_LLM_PROVIDER).lower()
    stt_provider = (stt.get("provider") or DEFAULT_STT_PROVIDER).lower()
    tts_provider = (tts.get("provider") or DEFAULT_TTS_PROVIDER).lower()

    return {
        "llm": {
            "provider": llm_provider,
            "model": llm.get("model") or DEFAULT_LLM_MODEL,
            "api_key": (llm.get("apiKey") or "").strip() or provider_key("llm", llm_provider) or "",
        },
        "stt": {
            "provider": stt_provider,
            "model": stt.get("model") or DEFAULT_STT_MODEL,
            "language": stt.get("language"),
            "mode": stt.get("mode"),
            "api_key": (stt.get("apiKey") or "").strip() or provider_key("stt", stt_provider) or "",
        },
        "tts": {
            "provider": tts_provider,
            "model": tts.get("model") or DEFAULT_TTS_MODEL,
            "voice": tts.get("voice") or DEFAULT_TTS_VOICE,
            "target_language_code": tts.get("targetLanguageCode"),
            "api_key": (tts.get("apiKey") or "").strip() or provider_key("tts", tts_provider) or "",
        },
    }


async def run_interview(ctx: JobContext, meta: dict):
    if meta.get("mode") != "video_interview":
        raise ValueError("Expected mode=video_interview in dispatch metadata")

    session_id = meta.get("sessionId") or str(uuid4())
    interview_id = meta.get("interviewId", "")
    candidate_id = meta.get("candidateId", "")
    interview_meta = meta.get("interviewMeta") or {}
    duration_minutes = int(interview_meta.get("durationMinutes") or 35)
    duration_seconds = max(60, min(180 * 60, duration_minutes * 60))

    prompt = build_prompt(meta)
    provider_cfg = resolve_provider_cfg(meta)
    llm = get_llm(provider_cfg["llm"]["provider"], provider_cfg["llm"]["api_key"], provider_cfg["llm"]["model"])
    stt = get_stt(
        provider_cfg["stt"]["provider"],
        provider_cfg["stt"]["api_key"],
        provider_cfg["stt"]["model"],
        provider_cfg["stt"]["language"],
        provider_cfg["stt"]["mode"],
    )
    tts = get_tts(
        provider_cfg["tts"]["provider"],
        provider_cfg["tts"]["api_key"],
        provider_cfg["tts"]["voice"],
        provider_cfg["tts"]["model"],
        provider_cfg["tts"]["target_language_code"],
    )

    transcript_lines: list[dict] = []

    def on_user_transcribed(ev):
        line = {
            "role": "user",
            "text": getattr(ev, "transcript", "") or "",
            "is_final": bool(getattr(ev, "is_final", False)),
            "created_at": now_iso(),
        }
        if not line["text"].strip():
            return
        transcript_lines.append(line)
        db.interview_events.insert_one({
            "id": str(uuid4()),
            "session_id": session_id,
            "type": "transcript",
            "payload": line,
            "created_at": line["created_at"],
        })

    def on_conversation_item(ev):
        item = getattr(ev, "item", None) or {}
        role = getattr(item, "role", "") or ""
        if role not in ("assistant", "agent"):
            return
        text = getattr(item, "text_content", "") or getattr(item, "text", "") or ""
        if not text.strip():
            return
        line = {"role": "assistant", "text": text, "is_final": True, "created_at": now_iso()}
        transcript_lines.append(line)
        db.interview_events.insert_one({
            "id": str(uuid4()),
            "session_id": session_id,
            "type": "transcript",
            "payload": line,
            "created_at": line["created_at"],
        })

    await ctx.connect()
    session = AgentSession()
    agent = Agent(instructions=prompt, stt=stt, llm=llm, tts=tts)
    session.on("user_input_transcribed", on_user_transcribed)
    session.on("conversation_item_added", on_conversation_item)
    room_options = room_io.RoomOptions(video_input=True)
    if candidate_id:
        room_options.participant_identity = f"candidate_{candidate_id}"
    avatar_started = False
    if ENABLE_AVATAR and AVATAR_PROVIDER == "simli":
        if simli is None:
            logging.warning("[Avatar] ENABLE_AVATAR=true but simli plugin not installed, continuing voice-only")
        elif not (SIMLI_API_KEY and SIMLI_FACE_ID):
            logging.warning("[Avatar] Missing SIMLI_API_KEY/SIMLI_FACE_ID, continuing voice-only")
        else:
            simli_cfg = simli.SimliConfig(api_key=SIMLI_API_KEY, face_id=SIMLI_FACE_ID)
            if SIMLI_EMOTION_ID:
                simli_cfg.emotion_id = SIMLI_EMOTION_ID
            avatar = simli.AvatarSession(simli_config=simli_cfg)
            await avatar.start(session, room=ctx.room)
            # Per LiveKit avatar docs: route audio via avatar worker, not directly from session.
            room_options.audio_output = False
            avatar_started = True

    await session.start(room=ctx.room, agent=agent, room_options=room_options)
    if avatar_started:
        logging.info("[Avatar] Simli avatar worker started for interview session")

    db.interview_sessions.update_one(
        {"session_id": session_id},
        {"$set": {"status": "in_progress", "updated_at": now_iso()}},
        upsert=True,
    )

    im = meta.get("interviewMeta") or {}
    has_prepared = bool(im.get("questions"))
    await session.generate_reply(
        instructions=(
            "Start the interview now: give a brief greeting, then ask the first substantive question. "
            + (
                "Use prepared question 1 exactly as the core ask (you may add one short clarification if needed)."
                if has_prepared
                else "Base the first question on the JD, must-ask topics, and candidate profile."
            )
        )
    )

    done = asyncio.Event()

    def on_disconnected(participant):
        identity = getattr(participant, "identity", "") or ""
        if identity.startswith("candidate_"):
            done.set()

    ctx.room.on("participant_disconnected", on_disconnected)
    try:
        await asyncio.wait_for(done.wait(), timeout=duration_seconds)
    except asyncio.TimeoutError:
        pass

    eval_doc = await generate_structured_evaluation(
        transcript_lines=transcript_lines,
        meta=meta,
        provider_cfg=provider_cfg,
    )
    stats = eval_doc.get("questionStats") or {}
    n = int(stats.get("total") or 0)
    strengths: list[str] = []
    gaps: list[str] = []
    if n > 0:
        c = int(stats.get("correct") or 0)
        p = int(stats.get("partially_correct") or 0)
        if c >= max(1, n // 2):
            strengths.append("Solid accuracy on multiple interview questions.")
        elif c + p >= max(1, n // 2):
            strengths.append("Showed partial understanding on several questions.")
        if int(stats.get("incorrect") or 0) + int(stats.get("could_not_answer") or 0) > n // 2:
            gaps.append("Several questions were missed, incorrect, or unanswered.")

    db.interview_evaluations.update_one(
        {"session_id": session_id},
        {"$set": {
            "session_id": session_id,
            "candidate_id": candidate_id,
            "interview_id": interview_id,
            "status": "completed",
            "summary": eval_doc["summary"],
            "questions": eval_doc["questions"],
            "overallPercent": eval_doc["overallPercent"],
            "questionStats": eval_doc["questionStats"],
            "scores": eval_doc["scores"],
            "strengths": strengths,
            "gaps": gaps,
            "recommendation": eval_doc["recommendation"],
            "completed_at": now_iso(),
        }},
        upsert=True,
    )
    db.interview_sessions.update_one(
        {"session_id": session_id},
        {"$set": {
            "status": "completed",
            "updated_at": now_iso(),
        }},
    )


async def entrypoint(ctx: JobContext):
    metadata = parse_metadata(getattr(ctx.job, "metadata", None))
    await run_interview(ctx, metadata)


if __name__ == "__main__":
    cli.run_app(WorkerOptions(agent_name=AGENT_NAME, entrypoint_fnc=entrypoint))


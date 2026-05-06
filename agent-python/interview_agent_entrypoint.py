"""
LiveKit Video Interview Agent entrypoint.
Used for candidate-side room interviews.
"""

import asyncio
import json
import logging
import os
from datetime import datetime
from pathlib import Path
from uuid import uuid4

from dotenv import load_dotenv
from livekit.agents import AgentSession, JobContext, WorkerOptions, cli, room_io
from livekit.agents.voice import Agent
from pymongo import MongoClient

from interview_evaluation import generate_structured_evaluation
from providers.llm import get_llm
from providers.stt import get_stt
from providers.tts import get_tts

load_dotenv(dotenv_path=Path(__file__).resolve().parent / ".env")

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
        ("tts", "xai"): ["XAI_API_KEY"],
        ("tts", "murf"): ["MURF_API_KEY"],
    }
    for key in provider_key_map.get((kind, provider), []):
        value = (os.getenv(key) or "").strip()
        if value:
            return value
    return None


def clean_api_key(value: str | None) -> str:
    v = (value or "").strip()
    if not v or v == "***":
        return ""
    return v


INTERVIEW_AGENT_DEFAULT_INSTRUCTIONS = """
You are a professional AI interviewer conducting a structured live interview.

Core behavior (always follow):
- Keep tone professional, fair, and encouraging.
- Greet the candidate briefly, confirm readiness, then move to substantive questions.
- Ask one clear question at a time; listen to the full answer before the next question.
- Use brief follow-ups to clarify, probe depth, or when the answer is incomplete.
- If needed, ask 1-2 follow-up questions before moving on.
- If the candidate asks for clarification, restate the same question in simpler words.
- Keep your spoken lines concise for real-time voice.
- Behave like a real human interviewer: adaptive, attentive, and conversational without being verbose.
- Close politely when the session ends, the candidate leaves, or time is nearly over.

Time and conclusion policy:
- You MUST conclude within the provided interview duration.
- Keep a small final wrap-up window for: final candidate comments/questions + polite closing.
- If the candidate is consistently non-responsive, off-topic, or repeatedly gives incorrect/very weak answers, conclude early in a professional way.
- If performance is weak for 2-3 answers in one skill, shift to another skill/topic instead of over-focusing on one weak area.
- If multiple skills are also weak, finish early with a polite close: ask if the candidate has questions, respond briefly, then end.

Question-source policy:
- If a numbered "Prepared questions" list is present, use it as the backbone and follow the order.
- Do NOT rely only on prepared questions; add probing follow-ups when needed to assess depth.
- If no prepared list is provided, generate technical/scenario-based questions aligned to JD, role, and experience.

Difficulty policy:
- Difficulty MUST match years of experience and role seniority.
- For less experienced candidates, keep questions simpler and practical.
- For more experienced candidates, include deeper reasoning, trade-offs, and scenario complexity.

Skills/topic/weightage policy (when provided):
- Input may include skills with topic lists and skill weightage percentage.
- Total skill weightage should be treated as 100%.
- Allocate interview focus/time proportionally by weightage.
- Cover must-ask topic areas during the interview (not only at start or end).
- Ensure each evaluated skill includes its specified topics whenever possible.

Language: conduct the interview primarily in the Primary language. If the candidate switches language, respond within Supported languages when reasonable.
""".strip()


def normalize_skill_specs(skill_specs: list[dict]) -> list[dict]:
    cleaned: list[dict] = []
    for raw in skill_specs:
        if not isinstance(raw, dict):
            continue
        name = str(raw.get("skill") or raw.get("name") or "").strip()
        if not name:
            continue
        topics_raw = raw.get("topics") or []
        topics = [str(t).strip() for t in topics_raw if str(t).strip()] if isinstance(topics_raw, list) else []
        weight_raw = raw.get("weightage")
        weight_val: float | None = None
        if isinstance(weight_raw, (int, float)):
            weight_val = float(weight_raw)
        elif isinstance(weight_raw, str):
            txt = weight_raw.strip().replace("%", "")
            try:
                weight_val = float(txt)
            except ValueError:
                weight_val = None
        if weight_val is not None:
            weight_val = max(0.0, min(100.0, weight_val))
        cleaned.append({
            "skill": name,
            "topics": topics,
            "weightage": weight_val,
        })
    return cleaned


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
    skill_specs_raw = interview_meta.get("skills") or interview_meta.get("skillWeights") or []
    if skill_specs_raw and not isinstance(skill_specs_raw, list):
        skill_specs_raw = []
    skill_specs = normalize_skill_specs(skill_specs_raw)
    duration_minutes = int(interview_meta.get("durationMinutes") or 35)

    lines: list[str] = [INTERVIEW_AGENT_DEFAULT_INSTRUCTIONS, ""]

    if extra_instructions:
        lines.append("Additional instructions from the employer (apply together with the defaults above):")
        lines.append(extra_instructions)
        lines.append("")

    lines.append(f"Interview title: {title}")
    lines.append(f"Primary language: {primary_language}")
    lines.append(f"Supported languages (language policy): {', '.join(language_policy)}")
    lines.append(f"Interview duration (minutes): {duration_minutes}")
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
    lines.append("Instruction: ensure must-ask topics are covered naturally during the interview flow.")
    lines.append("")

    if skill_specs:
        total_weight = sum(s["weightage"] for s in skill_specs if isinstance(s.get("weightage"), (int, float)))
        lines.append("Skill plan (follow this if present):")
        for i, s in enumerate(skill_specs, start=1):
            topic_line = ", ".join(s["topics"]) if s["topics"] else "(no explicit topics)"
            weight = s.get("weightage")
            weight_label = f"{weight:.2f}%".rstrip("0").rstrip(".") + "%" if isinstance(weight, float) else "unspecified"
            if isinstance(weight, float):
                weight_label = f"{weight:.0f}%" if weight.is_integer() else f"{weight:.2f}%"
            lines.append(f"  {i}. Skill: {s['skill']} | Topics: {topic_line} | Weightage: {weight_label}")
        if total_weight > 0:
            lines.append(f"Weightage total supplied: {total_weight:.0f}%")
        lines.append(
            "Rule: prioritize questions by skill weightage and topic importance; if any skill shows 2-3 below-average answers, shift to next skill."
        )
        lines.append("")

    if prepared_questions:
        lines.append("Prepared questions (ask in this order, one at a time):")
        for i, q in enumerate(prepared_questions, start=1):
            lines.append(f"  {i}. {q}")
        lines.append("")
    else:
        lines.append(
            "No fixed prepared question list — generate appropriate questions from the JD, Skills, topics, Experience, and candidate profile."
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
            "api_key": clean_api_key(llm.get("apiKey")) or provider_key("llm", llm_provider) or "",
        },
        "stt": {
            "provider": stt_provider,
            "model": stt.get("model") or DEFAULT_STT_MODEL,
            "language": stt.get("language"),
            "mode": stt.get("mode"),
            "api_key": clean_api_key(stt.get("apiKey")) or provider_key("stt", stt_provider) or "",
        },
        "tts": {
            "provider": tts_provider,
            "model": tts.get("model") or DEFAULT_TTS_MODEL,
            "voice": tts.get("voice") or DEFAULT_TTS_VOICE,
            "target_language_code": tts.get("targetLanguageCode"),
            "api_key": clean_api_key(tts.get("apiKey")) or provider_key("tts", tts_provider) or "",
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
    conclude_buffer_seconds = min(120, max(45, duration_seconds // 8))
    interview_drive_seconds = max(30, duration_seconds - conclude_buffer_seconds)

    prompt = build_prompt(meta)
    provider_cfg = resolve_provider_cfg(meta)
    logging.info(
        "[Interview] Runtime providers: llm=%s, stt=%s, tts=%s model=%s voice=%s key_present=%s",
        provider_cfg["llm"]["provider"],
        provider_cfg["stt"]["provider"],
        provider_cfg["tts"]["provider"],
        provider_cfg["tts"]["model"],
        provider_cfg["tts"]["voice"],
        bool(provider_cfg["tts"]["api_key"]),
    )
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

    done = asyncio.Event()
    candidate_joined = asyncio.Event()
    candidate_identity = f"candidate_{candidate_id}" if candidate_id else ""

    def on_disconnected(participant):
        identity = getattr(participant, "identity", "") or ""
        if identity.startswith("candidate_"):
            done.set()

    def on_connected(participant):
        identity = getattr(participant, "identity", "") or ""
        if candidate_identity:
            if identity == candidate_identity:
                candidate_joined.set()
        elif identity.startswith("candidate_"):
            candidate_joined.set()

    ctx.room.on("participant_connected", on_connected)
    ctx.room.on("participant_disconnected", on_disconnected)
    try:
        # Do not burn interview duration before the candidate actually appears in the room.
        already_present = False
        for rp in list(getattr(ctx.room, "remote_participants", {}).values()):
            rid = getattr(rp, "identity", "") or ""
            if (candidate_identity and rid == candidate_identity) or (not candidate_identity and rid.startswith("candidate_")):
                already_present = True
                break
        if already_present:
            candidate_joined.set()

        try:
            await asyncio.wait_for(candidate_joined.wait(), timeout=10 * 60)
        except asyncio.TimeoutError:
            logging.info("[Interview] Candidate did not join in prestart window; ending session workflow.")
            return

        db.interview_sessions.update_one(
            {"session_id": session_id, "started_at": {"$exists": False}},
            {"$set": {"started_at": now_iso(), "updated_at": now_iso()}},
        )

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

        await asyncio.wait_for(done.wait(), timeout=interview_drive_seconds)
    except asyncio.TimeoutError:
        await session.generate_reply(
            instructions=(
                "Begin interview wrap-up now. Ask one concise final check question only if essential, "
                "then ask whether the candidate has any final questions. Respond briefly and conclude "
                "politely now so the interview ends within the allotted time."
            )
        )
        try:
            await asyncio.wait_for(done.wait(), timeout=conclude_buffer_seconds)
        except asyncio.TimeoutError:
            logging.info("[Interview] Wrap-up timeout reached; ending session workflow.")
    finally:
        ctx.room.off("participant_connected", on_connected)
        ctx.room.off("participant_disconnected", on_disconnected)

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


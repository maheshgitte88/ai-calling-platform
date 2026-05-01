"""Post-interview structured evaluation: Q&A verdicts, dimension scores, deterministic overall %."""

from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Any

logger = logging.getLogger(__name__)

VERDICT_MULTIPLIER: dict[str, float] = {
    "correct": 1.0,
    "partially_correct": 0.5,
    "incorrect": 0.0,
    "could_not_answer": 0.0,
}

VERDICT_ALIASES: dict[str, str] = {
    "partial": "partially_correct",
    "partiallycorrect": "partially_correct",
    "partially_correct": "partially_correct",
    "partially correct": "partially_correct",
    "wrong": "incorrect",
    "incorrect": "incorrect",
    "correct": "correct",
    "right": "correct",
    "could_not_answer": "could_not_answer",
    "could not answer": "could_not_answer",
    "no_answer": "could_not_answer",
    "none": "could_not_answer",
}


def format_transcript_chronological(transcript_lines: list[dict]) -> str:
    """Build readable transcript: final user lines + all assistant lines, in order."""
    lines_out: list[str] = []
    for line in transcript_lines:
        role = line.get("role") or ""
        text = (line.get("text") or "").strip()
        if not text:
            continue
        if role == "user" and not line.get("is_final"):
            continue
        if role == "assistant":
            lines_out.append(f"Interviewer: {text}")
        elif role == "user":
            lines_out.append(f"Candidate: {text}")
    return "\n".join(lines_out) if lines_out else "(empty transcript)"


def normalize_verdict(raw: str | None) -> str:
    if not raw:
        return "could_not_answer"
    key = re.sub(r"[\s-]+", "_", str(raw).strip().lower())
    key = re.sub(r"[^a-z_]", "", key)
    if key in VERDICT_ALIASES:
        return VERDICT_ALIASES[key]
    if key in VERDICT_MULTIPLIER:
        return key
    return "could_not_answer"


def clamp_words(text: str, max_words: int = 60) -> str:
    words = text.split()
    if len(words) <= max_words:
        return text.strip()
    return " ".join(words[:max_words]).rstrip(".,;:") + "…"


def score_questions(questions: list[dict]) -> tuple[list[dict], float, dict[str, int]]:
    n = len(questions)
    stats = {"total": n, "correct": 0, "partially_correct": 0, "incorrect": 0, "could_not_answer": 0}
    if n == 0:
        return [], 0.0, stats
    per = 100.0 / n
    total = 0.0
    enriched: list[dict] = []
    for q in questions:
        verdict = normalize_verdict(q.get("verdict"))
        bucket = verdict if verdict in VERDICT_MULTIPLIER else "could_not_answer"
        stats[bucket] += 1
        mult = VERDICT_MULTIPLIER.get(bucket, 0.0)
        earned = per * mult
        total += earned
        enriched.append({
            "question": (q.get("question") or "").strip(),
            "answer": (q.get("answer") or "").strip(),
            "verdict": bucket,
            "pointsMax": round(per, 4),
            "pointsEarned": round(earned, 4),
        })
    return enriched, round(total, 2), stats


def recommendation_from_overall(overall: float) -> str:
    if overall >= 70:
        return "shortlist"
    if overall >= 50:
        return "hold"
    return "reject"


def _parse_json_object(raw: str) -> dict[str, Any]:
    raw = raw.strip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        m = re.search(r"\{[\s\S]*\}", raw)
        if m:
            return json.loads(m.group(0))
        raise


async def _openai_json_eval(
    *,
    api_key: str,
    model: str,
    base_url: str | None,
    system: str,
    user: str,
) -> dict[str, Any]:
    from openai import AsyncOpenAI

    client = AsyncOpenAI(api_key=api_key, base_url=base_url)
    resp = await client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        response_format={"type": "json_object"},
        temperature=0.2,
    )
    content = resp.choices[0].message.content or "{}"
    return _parse_json_object(content)


async def _gemini_json_eval(*, api_key: str, model: str, system: str, user: str) -> dict[str, Any]:
    import google.generativeai as genai

    def _call() -> str:
        genai.configure(api_key=api_key)
        m = genai.GenerativeModel(model_name=model)
        combined = f"{system}\n\n{user}"
        try:
            gc = genai.types.GenerationConfig(
                response_mime_type="application/json",
                temperature=0.2,
            )
        except Exception:
            gc = {"response_mime_type": "application/json", "temperature": 0.2}
        r = m.generate_content(combined, generation_config=gc)
        return r.text or "{}"

    text = await asyncio.to_thread(_call)
    return _parse_json_object(text)


async def generate_structured_evaluation(
    *,
    transcript_lines: list[dict],
    meta: dict,
    provider_cfg: dict,
) -> dict[str, Any]:
    """
    Returns evaluation dict for MongoDB: summary, questions, overallPercent, questionStats, scores, recommendation.
    """
    transcript_text = format_transcript_chronological(transcript_lines)
    jd = meta.get("jd") or {}
    interview_meta = meta.get("interviewMeta") or {}
    title = interview_meta.get("title") or "Interview"
    must_ask = interview_meta.get("mustAskTopics") or []

    system = (
        "You evaluate interview transcripts. Reply with ONLY valid JSON matching this shape:\n"
        "{\n"
        '  "executiveSummary": string,\n'
        '  "questions": [\n'
        "    {\n"
        '      "question": string,\n'
        '      "answer": string,\n'
        '      "verdict": "correct" | "partially_correct" | "incorrect" | "could_not_answer"\n'
        "    }\n"
        "  ],\n"
        '  "dimensionScores": {\n'
        '    "communication": number,\n'
        '    "technicalDepth": number,\n'
        '    "problemSolving": number\n'
        "  }\n"
        "}\n"
        "Rules:\n"
        "- executiveSummary: 50–60 words max. Qualitative narrative only. "
        "Do NOT include counts of messages, responses, or words.\n"
        "- questions: ONLY substantive interview questions (exclude greetings, small talk, and pure introduction). "
        "Chronological order. Pair each question with the candidate answer that directly responds.\n"
        "- verdict: correct = answer is satisfactory and largely accurate; partially_correct = some gaps; "
        "incorrect = materially wrong; could_not_answer = no real answer, refusal, or off-topic non-answer.\n"
        "- dimensionScores: integers 0–100, independent of each other. "
        "communication = fluency, grammar, clarity; technicalDepth = technical accuracy vs role; "
        "problemSolving = practical / real-work problem handling.\n"
    )

    user = (
        f"Interview title: {title}\n"
        f"Role / JD hints: {jd.get('title') or jd.get('summary') or 'N/A'}\n"
        f"Must-ask topics: {', '.join(must_ask) if must_ask else 'N/A'}\n\n"
        f"Transcript:\n{transcript_text}\n"
    )

    llm = provider_cfg.get("llm") or {}
    provider = (llm.get("provider") or "openai").lower()
    api_key = (llm.get("api_key") or "").strip()
    model = llm.get("model") or "gpt-4o-mini"

    parsed: dict[str, Any] = {}
    try:
        if provider == "gemini":
            if not api_key:
                raise ValueError("Missing Gemini API key")
            parsed = await _gemini_json_eval(api_key=api_key, model=model, system=system, user=user)
        elif provider in ("openai",):
            if not api_key:
                raise ValueError("Missing OpenAI API key")
            parsed = await _openai_json_eval(api_key=api_key, model=model, base_url=None, system=system, user=user)
        elif provider == "deepseek":
            if not api_key:
                raise ValueError("Missing DeepSeek API key")
            parsed = await _openai_json_eval(
                api_key=api_key,
                model=model,
                base_url="https://api.deepseek.com/v1",
                system=system,
                user=user,
            )
        elif provider in ("grok", "xai"):
            if not api_key:
                raise ValueError("Missing xAI API key")
            parsed = await _openai_json_eval(
                api_key=api_key,
                model=model,
                base_url="https://api.x.ai/v1",
                system=system,
                user=user,
            )
        else:
            raise ValueError(f"Evaluation not implemented for LLM provider: {provider}")
    except Exception as e:
        logger.exception("Structured evaluation LLM failed: %s", e)
        parsed = {
            "executiveSummary": "Evaluation could not be generated automatically. See transcript for details.",
            "questions": [],
            "dimensionScores": {"communication": 0, "technicalDepth": 0, "problemSolving": 0},
        }

    summary = clamp_words(str(parsed.get("executiveSummary") or "").strip() or "No summary available.", 60)
    raw_questions = parsed.get("questions") if isinstance(parsed.get("questions"), list) else []
    dim = parsed.get("dimensionScores") if isinstance(parsed.get("dimensionScores"), dict) else {}

    def _clip_dim(v: Any) -> int:
        try:
            return max(0, min(100, int(round(float(v)))))
        except (TypeError, ValueError):
            return 0

    scores = {
        "communication": _clip_dim(dim.get("communication")),
        "technicalDepth": _clip_dim(dim.get("technicalDepth")),
        "problemSolving": _clip_dim(dim.get("problemSolving")),
    }

    enriched_q, overall_pct, stats = score_questions([dict(x) for x in raw_questions if isinstance(x, dict)])
    rec = recommendation_from_overall(overall_pct)

    return {
        "summary": summary,
        "questions": enriched_q,
        "overallPercent": overall_pct,
        "questionStats": stats,
        "scores": scores,
        "recommendation": rec,
    }

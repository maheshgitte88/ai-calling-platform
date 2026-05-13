"""Post-interview structured evaluation.

Pipeline (per interview):

1. Render transcript chronologically.
2. PASS 1 — Chain-of-Thought analysis (free text). The LLM reads the transcript
   and explains, per substantive question, what was asked, what was answered,
   which skill it probed, and whether the answer was substantive vs fluent-but-shallow.
3. PASS 2 — Strict JSON scoring. The LLM scores each Q&A pair on three
   independent axes (accuracy, depth, practical) on a 0–4 ordinal scale. The
   *style* of the answer is intentionally excluded from per-question scoring;
   communication is captured separately at the dimension level only.
4. Deterministic post-processing:
   - per-question score = (0.5*accuracy + 0.3*depth + 0.2*practical) * 25 → 0..100
   - verdict (legacy) is derived from the score.
   - per-skill score = MEAN of question scores within that skill.
   - overall %      = Σ(skill_score × skill_weightage) / Σ(weightages_with_data),
                      i.e. weighted average across skills (NOT question-count-weighted).
                      Falls back to flat mean of question scores when no weights.
5. Self-consistency flags surface mismatches (e.g. summary says "weak" but
   overall ≥ 70, or communication ≫ technicalDepth) so reviewers can spot-check.

Backwards compatibility: this function returns the same keys it always did
(``summary``, ``questions``, ``overallPercent``, ``questionStats``,
``scores``, ``recommendation``) plus three additive keys (``perSkillScores``,
``skillWeights``, ``evaluationFlags``).
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Any

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Per-question scoring constants
# ---------------------------------------------------------------------------

# Weights for combining the three independent axes into a single 0..100 score.
# Sum must be 1.0; bias is intentionally toward technical accuracy.
AXIS_WEIGHTS: dict[str, float] = {
    "accuracy": 0.5,
    "depth": 0.3,
    "practical": 0.2,
}

# Verdict mapping derived from the 0..100 score (kept for back-compat with the
# old dashboard's question-stats block, with "weak" added as a separate bucket).
def _verdict_from_score(score: float) -> str:
    if score >= 80:
        return "correct"
    if score >= 40:
        return "partially_correct"
    if score >= 20:
        return "weak"
    if score > 0:
        return "incorrect"
    return "could_not_answer"


# Aliases preserved so older payloads with raw verdict strings still normalize.
VERDICT_ALIASES: dict[str, str] = {
    "partial": "partially_correct",
    "partiallycorrect": "partially_correct",
    "partially_correct": "partially_correct",
    "partially correct": "partially_correct",
    "wrong": "incorrect",
    "incorrect": "incorrect",
    "weak": "weak",
    "weak_answer": "weak",
    "weak answer": "weak",
    "correct": "correct",
    "right": "correct",
    "could_not_answer": "could_not_answer",
    "could not answer": "could_not_answer",
    "no_answer": "could_not_answer",
    "none": "could_not_answer",
}


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------


def format_transcript_chronological(transcript_lines: list[dict]) -> str:
    """Render readable transcript: final user lines + all assistant lines, in order."""
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
    """Normalize verdict strings to the canonical verdict buckets."""
    if not raw:
        return "could_not_answer"
    key = re.sub(r"[\s-]+", "_", str(raw).strip().lower())
    key = re.sub(r"[^a-z_]", "", key)
    if key in VERDICT_ALIASES:
        return VERDICT_ALIASES[key]
    return "could_not_answer"


def clamp_words(text: str, max_words: int = 60) -> str:
    words = text.split()
    if len(words) <= max_words:
        return text.strip()
    return " ".join(words[:max_words]).rstrip(".,;:") + "…"


def _clip_axis(value: Any) -> int:
    """Clip an axis score to 0..4 (integer)."""
    try:
        return max(0, min(4, int(round(float(value)))))
    except (TypeError, ValueError):
        return 0


def _clip_dim(value: Any) -> int:
    """Clip a dimension score (communication / technicalDepth / problemSolving) to 0..100."""
    try:
        return max(0, min(100, int(round(float(value)))))
    except (TypeError, ValueError):
        return 0


def _per_question_score(accuracy: int, depth: int, practical: int) -> float:
    """Combine the three 0..4 axes into a single 0..100 score."""
    raw = (
        AXIS_WEIGHTS["accuracy"] * accuracy
        + AXIS_WEIGHTS["depth"] * depth
        + AXIS_WEIGHTS["practical"] * practical
    )
    return round(raw * 25.0, 2)  # 0..4 axis * 25 = 0..100 contribution


# ---------------------------------------------------------------------------
# Skill-weight resolution (works for both interview flows)
# ---------------------------------------------------------------------------


def _parse_weight(raw: Any) -> float | None:
    if isinstance(raw, (int, float)) and not isinstance(raw, bool):
        return float(raw)
    if isinstance(raw, str) and raw.strip():
        try:
            return float(raw.replace("%", "").strip())
        except ValueError:
            return None
    return None


def resolve_skill_weights(meta: dict) -> dict[str, float]:
    """Build a unified ``{skill: weightage_percent}`` from the interview metadata.

    Either flow can supply weightage:
      - Mode A (prepared per-skill questions): ``interviewMeta.questions[*].weightage``
      - Mode B (skills-with-weightage):        ``interviewMeta.skills[*].weightage``

    If both flows are present (rare), prepared-question weightage wins and
    skill-spec weightage is used only for skills not already covered.
    Missing or non-positive weights are dropped.
    """
    interview_meta = meta.get("interviewMeta") or {}
    weights: dict[str, float] = {}

    for q in interview_meta.get("questions") or []:
        if not isinstance(q, dict):
            continue
        skill = str(q.get("skill") or "").strip()
        if not skill:
            continue
        w = _parse_weight(q.get("weightage"))
        if w is not None and w > 0:
            weights[skill] = w

    for s in interview_meta.get("skills") or []:
        if not isinstance(s, dict):
            continue
        skill = str(s.get("skill") or s.get("name") or "").strip()
        if not skill or skill in weights:
            continue
        w = _parse_weight(s.get("weightage"))
        if w is not None and w > 0:
            weights[skill] = w

    return weights


# ---------------------------------------------------------------------------
# LLM JSON / text callers (one per provider family)
# ---------------------------------------------------------------------------


def _parse_json_object(raw: str) -> dict[str, Any]:
    raw = raw.strip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        m = re.search(r"\{[\s\S]*\}", raw)
        if m:
            return json.loads(m.group(0))
        raise


async def _openai_text(
    *, api_key: str, model: str, base_url: str | None, system: str, user: str
) -> str:
    from openai import AsyncOpenAI

    client = AsyncOpenAI(api_key=api_key, base_url=base_url)
    resp = await client.chat.completions.create(
        model=model,
        messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
        temperature=0.2,
    )
    return resp.choices[0].message.content or ""


async def _openai_json(
    *, api_key: str, model: str, base_url: str | None, system: str, user: str
) -> dict[str, Any]:
    from openai import AsyncOpenAI

    client = AsyncOpenAI(api_key=api_key, base_url=base_url)
    resp = await client.chat.completions.create(
        model=model,
        messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
        response_format={"type": "json_object"},
        temperature=0.2,
    )
    return _parse_json_object(resp.choices[0].message.content or "{}")


async def _gemini_text(*, api_key: str, model: str, system: str, user: str) -> str:
    import google.generativeai as genai

    def _call() -> str:
        genai.configure(api_key=api_key)
        m = genai.GenerativeModel(model_name=model)
        try:
            gc = genai.types.GenerationConfig(temperature=0.2)
        except Exception:
            gc = {"temperature": 0.2}
        r = m.generate_content(f"{system}\n\n{user}", generation_config=gc)
        return r.text or ""

    return await asyncio.to_thread(_call)


async def _gemini_json(*, api_key: str, model: str, system: str, user: str) -> dict[str, Any]:
    import google.generativeai as genai

    def _call() -> str:
        genai.configure(api_key=api_key)
        m = genai.GenerativeModel(model_name=model)
        try:
            gc = genai.types.GenerationConfig(
                response_mime_type="application/json", temperature=0.2
            )
        except Exception:
            gc = {"response_mime_type": "application/json", "temperature": 0.2}
        r = m.generate_content(f"{system}\n\n{user}", generation_config=gc)
        return r.text or "{}"

    text = await asyncio.to_thread(_call)
    return _parse_json_object(text)


def _provider_base_url(provider: str) -> str | None:
    if provider == "deepseek":
        return "https://api.deepseek.com/v1"
    if provider in ("grok", "xai"):
        return "https://api.x.ai/v1"
    return None


async def _eval_text(provider: str, api_key: str, model: str, system: str, user: str) -> str:
    if provider == "gemini":
        return await _gemini_text(api_key=api_key, model=model, system=system, user=user)
    if provider in ("openai", "deepseek", "grok", "xai"):
        return await _openai_text(
            api_key=api_key,
            model=model,
            base_url=_provider_base_url(provider),
            system=system,
            user=user,
        )
    raise ValueError(f"Evaluation not implemented for LLM provider: {provider}")


async def _eval_json(provider: str, api_key: str, model: str, system: str, user: str) -> dict[str, Any]:
    if provider == "gemini":
        return await _gemini_json(api_key=api_key, model=model, system=system, user=user)
    if provider in ("openai", "deepseek", "grok", "xai"):
        return await _openai_json(
            api_key=api_key,
            model=model,
            base_url=_provider_base_url(provider),
            system=system,
            user=user,
        )
    raise ValueError(f"Evaluation not implemented for LLM provider: {provider}")


# ---------------------------------------------------------------------------
# Prompts (PASS 1 = analysis CoT, PASS 2 = strict JSON scoring)
# ---------------------------------------------------------------------------


_ANALYSIS_SYSTEM_PROMPT = """
You analyze interview transcripts.

CRITICAL RULES:
- ONLY use transcript content.
- NEVER invent answers.
- NEVER merge unrelated answers.
- Preserve exact conversation order.

QUESTION-ANSWER MAPPING RULES:
1. Every interviewer question maps to its relevant candidate response.
2. Stop an answer when:
   - a completely new topic starts
   - a different technical concept is asked
3. Clarification follow-ups belong to the SAME parent question when:
   - the interviewer asks the candidate to clarify
   - the interviewer says:
     "explain more"
     "I asked about X"
     "can you elaborate"
     "what do you mean"
     "I asked final, not super"
     or similar correction/clarification prompts
4. In clarification chains:
   - combine the clarification exchange into ONE final evaluated answer
   - prefer the clarified technical answer over the earlier vague response
5. Mark the initial vague answer as weak/incomplete if needed.
6. The FINAL clarified response should be treated as the primary answer.
7. Do NOT split clarification loops into unrelated Q&A pairs.

EXAMPLE BEHAVIOR:

Interviewer:
"What is final keyword in Java?"

Candidate:
"super"

Interviewer:
"I asked final, explain final keyword."

Candidate:
"final is used to prevent inheritance, method overriding, or variable reassignment."

Correct handling:
- Treat this as ONE question thread
- Final evaluated answer is the clarified explanation
- Mention that the candidate initially misunderstood the question

IMPORTANT:
- Clarifications are NOT new questions if they refine the same concept.
- Topic changes ARE new questions.
- Follow-up depth questions belong to the same thread.
- New independent concepts create a new question.

OUTPUT FORMAT:

Question:
- original interviewer question

Answer:
- consolidated answer for that question thread

Clarification Notes:
- mention if interviewer had to redirect or correct the candidate

Skill:
- mapped skill

Strengths:
- explicit demonstrated knowledge

Weaknesses:
- confusion, correction needed, shallow understanding, etc.

Communication vs Substance:
- distinguish fluency vs actual technical accuracy

Be concise.
Use bullets.
""".strip()


_SCORING_SYSTEM_PROMPT = """
You score interview answers using a strict rubric. Reply with ONLY valid JSON.

CRITICAL RULES (read these first):
- Score the SUBSTANCE of each answer. Do NOT reward fluency, length, or confidence — only correctness and depth.
- Two answers with identical technical content must score identically, regardless of how smoothly they were spoken.
- Communication is scored separately at the dimension level only. Per-question axes (accuracy / depth / practical) MUST NOT be influenced by speaking style or grammar.
- A long, smoothly-spoken answer that misses key technical points is LOW on accuracy/depth/practical, even if it sounds confident.
- A short, blunt answer that nails the key technical points is HIGH on accuracy, even if delivery is plain.

Output JSON shape (no extra fields, no comments):
{
  "executiveSummary": string,            // 50-60 words, qualitative narrative only
  "questions": [
    {
      "question": string,                // the interviewer's actual question
      "answer":   string,                // the candidate's actual answer (or "no answer")
      "skillScored": string,             // EXACT skill name from the provided skill list, or "" if none fit
      "accuracy":  0|1|2|3|4,
      "depth":     0|1|2|3|4,
      "practical": 0|1|2|3|4,
      "rationale": string                // ONE short sentence justifying the three axis scores
    }
  ],
  "dimensionScores": {
    "communication": 0-100,              // fluency, grammar, clarity ONLY
    "technicalDepth": 0-100,             // overall technical accuracy across the interview
    "problemSolving": 0-100              // applied / scenario reasoning
  }
}

Per-axis scoring anchors (0-4):
- 4 = strong: covers all key points correctly; concrete examples and/or trade-offs.
- 3 = good:   mostly correct; minor gaps.
- 2 = partial: some correct elements; important gaps.
- 1 = weak:   surface-level or notable errors.
- 0 = none:   refusal, off-topic, or wrong on all key points.

Other rules:
- "questions" must be in chronological order. Skip greetings and small-talk.
- Pair each question with the candidate's directly-responding answer.
- For "skillScored", use the EXACT spelling from the provided skill list (case-sensitive). If no skill fits, use "".
""".strip()


_FALLBACK_RESULT: dict[str, Any] = {
    "executiveSummary": "Evaluation could not be generated automatically. See transcript for details.",
    "questions": [],
    "dimensionScores": {"communication": 0, "technicalDepth": 0, "problemSolving": 0},
}


def _format_skill_list(meta: dict) -> str:
    """Render the skill list (with weightage if any) for the eval prompt context."""
    interview_meta = meta.get("interviewMeta") or {}
    weights = resolve_skill_weights(meta)

    skills: list[str] = []
    seen: set[str] = set()
    for s in interview_meta.get("skills") or []:
        skill = str((s.get("skill") or s.get("name") or "")).strip() if isinstance(s, dict) else str(s).strip()
        if skill and skill not in seen:
            seen.add(skill)
            skills.append(skill)
    for q in interview_meta.get("questions") or []:
        if isinstance(q, dict):
            skill = str(q.get("skill") or "").strip()
            if skill and skill not in seen:
                seen.add(skill)
                skills.append(skill)

    if not skills:
        return "(no skill list provided — set skillScored to \"\")"

    lines: list[str] = []
    for s in skills:
        w = weights.get(s)
        lines.append(f"- {s}" + (f" (weightage: {w:.0f}%)" if w else ""))
    return "\n".join(lines)


def _format_prepared_questions(meta: dict) -> str:
    """Render prepared-question groups (legacy strings or new structured form)."""
    interview_meta = meta.get("interviewMeta") or {}
    raw = interview_meta.get("questions") or []
    if not isinstance(raw, list) or not raw:
        return "N/A"

    out: list[str] = []
    for q in raw:
        if isinstance(q, str):
            stripped = q.strip()
            if stripped:
                out.append(f"  - {stripped}")
            continue
        if not isinstance(q, dict):
            continue
        skill = str(q.get("skill") or "").strip()
        questions = q.get("questions") or []
        if not isinstance(questions, list) or not questions:
            continue
        header = f"[{skill}]" if skill else "[General]"
        out.append(f"  {header}")
        for item in questions:
            text = str(item).strip()
            if text:
                out.append(f"    - {text}")
    return "\n".join(out) if out else "N/A"


def _format_must_ask_topics(meta: dict) -> str:
    """Render must-ask topics (legacy strings or new structured form)."""
    raw = (meta.get("interviewMeta") or {}).get("mustAskTopics") or []
    if not isinstance(raw, list) or not raw:
        return "N/A"
    parts: list[str] = []
    for item in raw:
        if isinstance(item, str):
            t = item.strip()
            if t:
                parts.append(t)
        elif isinstance(item, dict):
            t = str(item.get("topic") or "").strip()
            if t:
                parts.append(t + (" (ask now)" if item.get("askNow") else ""))
    return ", ".join(parts) if parts else "N/A"


def _build_analysis_user_prompt(meta: dict, transcript_text: str) -> str:
    interview_meta = meta.get("interviewMeta") or {}
    cand = meta.get("candidateProfile") or {}
    jd = meta.get("jd") or {}

    title = interview_meta.get("title") or "Interview"
    cand_skills = ", ".join(str(s) for s in (cand.get("skills") or [])) or "N/A"
    cand_exp = cand.get("yearsExperience")

    jd_hint = (jd.get("title") or "")
    if jd.get("text") or jd.get("summary"):
        jd_hint += f" | {(jd.get('text') or jd.get('summary'))[:1200]}"

    return (
        f"Interview title: {title}\n"
        f"Role / JD: {jd_hint or 'N/A'}\n"
        f"Candidate yearsExperience: {cand_exp if cand_exp is not None else 'N/A'}\n"
        f"Candidate skills: {cand_skills}\n"
        f"Skill list to map answers to:\n{_format_skill_list(meta)}\n"
        f"Must-ask topics: {_format_must_ask_topics(meta)}\n"
        f"Prepared questions (if any):\n{_format_prepared_questions(meta)}\n\n"
        f"Transcript:\n{transcript_text}\n"
    )


def _build_scoring_user_prompt(meta: dict, transcript_text: str, analysis_text: str) -> str:
    interview_meta = meta.get("interviewMeta") or {}
    cand = meta.get("candidateProfile") or {}
    cand_exp = cand.get("yearsExperience")

    return (
        f"Interview title: {interview_meta.get('title') or 'Interview'}\n"
        f"Candidate yearsExperience: {cand_exp if cand_exp is not None else 'N/A'}\n"
        f"Skill list (use exact names for skillScored):\n{_format_skill_list(meta)}\n"
        f"Must-ask topics: {_format_must_ask_topics(meta)}\n\n"
        f"Internal analysis from the previous step (use as a guide; you may correct it if needed):\n"
        f"{analysis_text or '(no analysis available)'}\n\n"
        f"Transcript:\n{transcript_text}\n\n"
        f"Now produce the strict JSON scoring per the system rules."
    )


# ---------------------------------------------------------------------------
# Post-processing: per-question, per-skill, overall
# ---------------------------------------------------------------------------


def _normalize_evaluated_questions(
    raw: list, allowed_skills: set[str]
) -> list[dict]:
    """Apply axis clipping, derive verdict + score, and snap skillScored to the allowed set."""
    enriched: list[dict] = []
    for q in raw:
        if not isinstance(q, dict):
            continue
        accuracy = _clip_axis(q.get("accuracy"))
        depth = _clip_axis(q.get("depth"))
        practical = _clip_axis(q.get("practical"))
        score = _per_question_score(accuracy, depth, practical)
        skill_raw = str(q.get("skillScored") or "").strip()
        skill = skill_raw if skill_raw in allowed_skills else ""
        enriched.append({
            "question": (q.get("question") or "").strip(),
            "answer": (q.get("answer") or "").strip(),
            "skillScored": skill,
            "accuracy": accuracy,
            "depth": depth,
            "practical": practical,
            "score": score,
            "verdict": _verdict_from_score(score),
            "rationale": (q.get("rationale") or "").strip(),
        })
    return enriched


def _aggregate_per_skill(questions: list[dict]) -> dict[str, float]:
    """Per-skill score = MEAN of question scores within that skill."""
    by_skill: dict[str, list[float]] = {}
    for q in questions:
        skill = q.get("skillScored") or ""
        if not skill:
            continue
        by_skill.setdefault(skill, []).append(float(q.get("score") or 0.0))
    return {s: round(sum(v) / len(v), 2) for s, v in by_skill.items() if v}


def _compute_overall_percent(
    per_skill: dict[str, float],
    skill_weights: dict[str, float],
    questions: list[dict],
) -> float:
    """Weighted average across skills (per-skill mean × weightage), or fallback to flat mean."""
    # Skill-weighted path: any per-skill score has a matching positive weight.
    weighted_sum = 0.0
    total_w = 0.0
    for skill, score in per_skill.items():
        w = skill_weights.get(skill)
        if w and w > 0:
            weighted_sum += score * w
            total_w += w
    if total_w > 0:
        # NB: skills with weight but zero scored questions are intentionally
        # excluded from the denominator — the candidate is not penalized for
        # the AI's failure to ask. Coverage gap is surfaced via flags.
        return round(weighted_sum / total_w, 2)

    # Equal-weight fallback across skills (some skills scored, no weights given).
    if per_skill:
        return round(sum(per_skill.values()) / len(per_skill), 2)

    # Final fallback: flat mean of question scores (no skill tagging happened).
    if questions:
        return round(sum(float(q.get("score") or 0) for q in questions) / len(questions), 2)
    return 0.0


def _question_stats(questions: list[dict]) -> dict[str, int]:
    """Legacy verdict counts — kept for the dashboard's question-stats card."""
    stats = {
        "total": len(questions),
        "correct": 0,
        "partially_correct": 0,
        "weak": 0,
        "incorrect": 0,
        "could_not_answer": 0,
    }
    for q in questions:
        verdict = q.get("verdict") or "could_not_answer"
        if verdict in stats:
            stats[verdict] += 1
        else:
            stats["could_not_answer"] += 1
    return stats


def recommendation_from_overall(overall: float) -> str:
    if overall >= 70:
        return "shortlist"
    if overall >= 50:
        return "hold"
    return "reject"


def _consistency_flags(
    *,
    summary: str,
    overall_percent: float,
    dim_scores: dict[str, int],
    per_skill: dict[str, float],
    skill_weights: dict[str, float],
) -> list[str]:
    """Surface mismatches a recruiter should manually spot-check."""
    flags: list[str] = []
    summary_l = summary.lower()
    if overall_percent >= 70 and any(w in summary_l for w in ("weak", "inadequate", "poor", "struggled")):
        flags.append("summary_says_weak_but_score_high")
    if overall_percent < 40 and any(w in summary_l for w in ("strong", "excellent", "great")):
        flags.append("summary_says_strong_but_score_low")

    comm = dim_scores.get("communication", 0)
    tech = dim_scores.get("technicalDepth", 0)
    if comm >= 80 and tech <= 30:
        flags.append("style_over_substance")
    if tech >= 80 and comm <= 30:
        flags.append("substance_over_style")

    # Coverage gaps — skills with weight but no questions evaluated.
    uncovered = [s for s, w in skill_weights.items() if w > 0 and s not in per_skill]
    if uncovered:
        flags.append("uncovered_weighted_skills:" + ",".join(uncovered))

    return flags


def _recommendation_with_flags(overall_percent: float, flags: list[str]) -> str:
    """Downgrade by one tier when consistency flags suggest the score may be inflated."""
    rec = recommendation_from_overall(overall_percent)
    inflation_flags = {"summary_says_weak_but_score_high", "style_over_substance"}
    if rec == "shortlist" and any(f in inflation_flags for f in flags):
        return "hold"
    if rec == "hold" and any(f in inflation_flags for f in flags):
        return "reject"
    return rec


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


async def generate_structured_evaluation(
    *,
    transcript_lines: list[dict],
    meta: dict,
    provider_cfg: dict,
) -> dict[str, Any]:
    """Generate the evaluation document persisted into MongoDB.

    Returns (all keys are stable for the dashboard):
        summary, questions, overallPercent, questionStats, scores, recommendation,
        perSkillScores, skillWeights, evaluationFlags
    """
    transcript_text = format_transcript_chronological(transcript_lines)
    skill_weights = resolve_skill_weights(meta)
    allowed_skills = set(_collect_skill_names(meta))

    llm = provider_cfg.get("llm") or {}
    provider = (llm.get("provider") or "openai").lower()
    api_key = (llm.get("api_key") or "").strip()
    model = llm.get("model") or "gpt-4o-mini"

    # PASS 1 — Chain-of-Thought analysis. Best-effort: failures don't block scoring.
    analysis_text = ""
    try:
        analysis_text = await _eval_text(
            provider, api_key, model, _ANALYSIS_SYSTEM_PROMPT,
            _build_analysis_user_prompt(meta, transcript_text),
        )
    except Exception as exc:
        logger.warning("Evaluation pass 1 (analysis) failed; continuing without it: %s", exc)

    # PASS 2 — strict JSON scoring.
    try:
        parsed = await _eval_json(
            provider, api_key, model, _SCORING_SYSTEM_PROMPT,
            _build_scoring_user_prompt(meta, transcript_text, analysis_text),
        )
    except Exception as exc:
        logger.exception("Evaluation pass 2 (scoring) failed: %s", exc)
        parsed = _FALLBACK_RESULT.copy()

    summary = clamp_words(
        str(parsed.get("executiveSummary") or "").strip() or "No summary available.", 60
    )
    raw_questions = parsed.get("questions") if isinstance(parsed.get("questions"), list) else []
    dim = parsed.get("dimensionScores") if isinstance(parsed.get("dimensionScores"), dict) else {}

    dim_scores = {
        "communication": _clip_dim(dim.get("communication")),
        "technicalDepth": _clip_dim(dim.get("technicalDepth")),
        "problemSolving": _clip_dim(dim.get("problemSolving")),
    }

    questions = _normalize_evaluated_questions(raw_questions, allowed_skills)
    per_skill = _aggregate_per_skill(questions)
    overall_percent = _compute_overall_percent(per_skill, skill_weights, questions)
    flags = _consistency_flags(
        summary=summary,
        overall_percent=overall_percent,
        dim_scores=dim_scores,
        per_skill=per_skill,
        skill_weights=skill_weights,
    )
    recommendation = _recommendation_with_flags(overall_percent, flags)

    return {
        "summary": summary,
        "questions": questions,
        "overallPercent": overall_percent,
        "questionStats": _question_stats(questions),
        "scores": dim_scores,
        "perSkillScores": per_skill,
        "skillWeights": skill_weights,
        "evaluationFlags": flags,
        "recommendation": recommendation,
    }


def _collect_skill_names(meta: dict) -> list[str]:
    """All skill names referenced by either flow (skills section + question groups)."""
    interview_meta = meta.get("interviewMeta") or {}
    seen: list[str] = []
    seen_set: set[str] = set()
    for src in (interview_meta.get("skills") or [], interview_meta.get("questions") or []):
        for item in src:
            skill = ""
            if isinstance(item, dict):
                skill = str(item.get("skill") or item.get("name") or "").strip()
            elif isinstance(item, str):
                skill = item.strip()
            if skill and skill not in seen_set:
                seen.append(skill)
                seen_set.add(skill)
    return seen


__all__ = [
    "AXIS_WEIGHTS",
    "VERDICT_ALIASES",
    "format_transcript_chronological",
    "normalize_verdict",
    "clamp_words",
    "resolve_skill_weights",
    "recommendation_from_overall",
    "generate_structured_evaluation",
]

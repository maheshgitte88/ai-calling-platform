"""Transcript-based verification gate before wrap-up."""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any, Iterable

from .evaluation import _eval_json
from .interview_plan import InterviewPlan, resolve_interview_plan
from .skills import canonical_skill_key

PREPARED_QUESTION_WRAPUP_MIN_COVERAGE = 0.8

_PREPARED_VERIFY_SYSTEM_PROMPT = """
You verify prepared-question interview coverage before wrap-up. Reply with ONLY valid JSON.

Rules:
- Be strict. If a required prepared question is uncertain, treat it as missing.
- Use only the interviewer transcript to decide whether a required prepared question was clearly asked or an unmistakable equivalent was asked.
- Prepared-question coverage depends on whether the interviewer asked it, not on whether the candidate answered well, partially, incorrectly, or said "I don't know".
- Never mark a prepared question as missing just because the candidate could not answer it after it was asked.
- The runtime may still authorize wrap-up when overall prepared-question coverage is high enough, so keep the missing list accurate and concise.
- Do not assume coverage from greetings, wrap-up, or vague mentions.
- Use the provided skill names and prepared question numbers from the plan. Treat common aliases like `React` and `React.js` as the same skill.

Output JSON shape:
{
  "verifiedPreparedQuestions": [
    { "skill": string, "questionNumbers": [integer] }
  ],
  "missingQuestions": [
    { "skill": string, "questionNumber": integer, "question": string }
  ],
  "readyForWrapup": boolean,
  "notes": string
}
""".strip()

_SKILLS_VERIFY_SYSTEM_PROMPT = """
You verify skills-only interview coverage before wrap-up. Reply with ONLY valid JSON.

Rules:
- Be strict. If a required skill is uncertain, treat it as missing.
- Use only the interviewer transcript to decide whether the interviewer substantively covered each skill.
- Candidate correctness does NOT determine whether a skill was covered. Incorrect, weak, or incomplete answers should usually be reflected in `notes`, not `missingSkills`.
- Mark a skill as verified when the interviewer spent meaningful time on that skill and covered multiple core areas, even if one subtopic was answered poorly or not answered.
- Mark a skill as missing only when the interviewer barely covered it, skipped it, or the candidate gave repeated non-responses so the skill never received real substantive coverage.
- Do not assume coverage from greetings, wrap-up, or vague mentions.
- Use the provided skill names from the plan. Treat common aliases like `React` and `React.js` as the same skill.

Output JSON shape:
{
  "verifiedSkills": [string],
  "missingSkills": [string],
  "readyForWrapup": boolean,
  "notes": string
}
""".strip()


@dataclass(frozen=True)
class PreWrapupVerificationResult:
    """Structured result returned by the transcript verification pass."""

    verified_question_marks: list[tuple[str, int]]
    verified_skill_completions: list[str]
    missing_items: list[dict]
    ready_for_wrapup: bool
    notes: str


def _prepared_question_plan(plan: InterviewPlan) -> list[dict]:
    out: list[dict] = []
    for group in plan.question_groups:
        skill = str(group.get("skill") or "").strip()
        questions = [str(q).strip() for q in group.get("questions") or [] if str(q).strip()]
        if not skill or not questions:
            continue
        out.append({
            "skill": skill,
            "questions": [
                {"questionNumber": i, "question": text}
                for i, text in enumerate(questions, start=1)
            ],
        })
    return out


def _skills_only_plan(plan: InterviewPlan) -> list[str]:
    return [spec["skill"] for spec in plan.skill_specs if spec.get("skill")]


def _prepared_question_total(plan: InterviewPlan) -> int:
    return sum(len(group.get("questions") or []) for group in plan.question_groups)


def _assistant_only_transcript(transcript_lines: list[dict]) -> str:
    lines_out: list[str] = []
    for line in transcript_lines:
        role = line.get("role") or ""
        text = str(line.get("text") or "").strip()
        if role != "assistant" or not text:
            continue
        lines_out.append(f"Interviewer: {text}")
    return "\n".join(lines_out) if lines_out else "(empty interviewer transcript)"


def _build_prepared_verification_user_prompt(plan: InterviewPlan, transcript_lines: list[dict]) -> str:
    prepared_plan = _prepared_question_plan(plan)
    transcript_text = _assistant_only_transcript(transcript_lines)

    prepared_lines = ["Prepared questions:"]
    for group in prepared_plan:
        prepared_lines.append(f"- Skill: {group['skill']}")
        for item in group["questions"]:
            prepared_lines.append(f"  - Question {item['questionNumber']}: {item['question']}")

    return "\n".join([
        *prepared_lines,
        "",
        "Interviewer transcript only:",
        "Use this transcript to decide what the interviewer actually asked.",
        "Do not require candidate answers to verify that a prepared question was asked.",
        "",
        transcript_text,
    ])


def _build_skills_verification_user_prompt(plan: InterviewPlan, transcript_lines: list[dict]) -> str:
    skill_plan = _skills_only_plan(plan)
    transcript_text = _assistant_only_transcript(transcript_lines)
    skill_lines = ["Required skills:"]
    skill_lines.extend(f"- {skill}" for skill in skill_plan)

    return "\n".join([
        *skill_lines,
        "",
        "Interviewer transcript only:",
        "Use this transcript to decide what the interviewer actually covered.",
        "",
        transcript_text,
    ])


def _display_skill_name_map(plan: InterviewPlan) -> dict[str, str]:
    display: dict[str, str] = {}
    for group in plan.question_groups:
        skill = str(group.get("skill") or "").strip()
        key = canonical_skill_key(skill)
        if key and key not in display:
            display[key] = skill
    for spec in plan.skill_specs:
        skill = str(spec.get("skill") or "").strip()
        key = canonical_skill_key(skill)
        if key and key not in display:
            display[key] = skill
    return display


def _normalize_skill_name(raw_skill: Any, display_map: dict[str, str]) -> str:
    skill = str(raw_skill or "").strip()
    key = canonical_skill_key(skill)
    if key and key in display_map:
        return display_map[key]
    return skill


def _normalize_verification_result(
    raw: dict[str, Any],
    plan: InterviewPlan,
    coverage_exempt_skills: Iterable[str] = (),
) -> PreWrapupVerificationResult:
    display_map = _display_skill_name_map(plan)
    exempt_keys = {
        canonical_skill_key(skill)
        for skill in coverage_exempt_skills
        if canonical_skill_key(skill)
    }
    verified_marks: list[tuple[str, int]] = []
    for entry in raw.get("verifiedPreparedQuestions") or []:
        if not isinstance(entry, dict):
            continue
        skill = _normalize_skill_name(entry.get("skill"), display_map)
        if not skill:
            continue
        question_numbers = entry.get("questionNumbers") or []
        if not isinstance(question_numbers, list):
            continue
        for item in question_numbers:
            try:
                question_number = int(item)
            except (TypeError, ValueError):
                continue
            if question_number > 0:
                verified_marks.append((skill, question_number))

    verified_skills: list[str] = []
    seen_verified: set[str] = set()
    for skill in (raw.get("verifiedSkills") or []):
        normalized = _normalize_skill_name(skill, display_map)
        key = canonical_skill_key(normalized)
        if normalized and key and key not in seen_verified:
            verified_skills.append(normalized)
            seen_verified.add(key)
    for skill in coverage_exempt_skills:
        normalized = _normalize_skill_name(skill, display_map)
        key = canonical_skill_key(normalized)
        if normalized and key and key not in seen_verified:
            verified_skills.append(normalized)
            seen_verified.add(key)

    missing_items: list[dict] = []
    raw_missing_skill_count = 0
    for entry in raw.get("missingQuestions") or []:
        if not isinstance(entry, dict):
            continue
        skill = _normalize_skill_name(entry.get("skill"), display_map)
        question = str(entry.get("question") or "").strip()
        try:
            question_number = int(entry.get("questionNumber"))
        except (TypeError, ValueError):
            continue
        if not skill or question_number <= 0:
            continue
        missing_items.append({
            "type": "question",
            "skill": skill,
            "question_number": question_number,
            "question": question,
        })

    for skill in raw.get("missingSkills") or []:
        skill_name = _normalize_skill_name(skill, display_map)
        key = canonical_skill_key(skill_name)
        if skill_name and key in exempt_keys:
            raw_missing_skill_count += 1
            continue
        if skill_name:
            raw_missing_skill_count += 1
            missing_items.append({"type": "skill", "skill": skill_name})

    exempted_only_missing = raw_missing_skill_count > 0 and not any(item["type"] == "skill" for item in missing_items)
    return PreWrapupVerificationResult(
        verified_question_marks=verified_marks,
        verified_skill_completions=verified_skills,
        missing_items=missing_items,
        ready_for_wrapup=(bool(raw.get("readyForWrapup")) or exempted_only_missing) and not missing_items,
        notes=str(raw.get("notes") or "").strip(),
    )


def _apply_prepared_question_tolerance(
    result: PreWrapupVerificationResult,
    plan: InterviewPlan,
) -> PreWrapupVerificationResult:
    total_questions = _prepared_question_total(plan)
    if total_questions <= 0 or result.ready_for_wrapup:
        return result

    missing_questions = [item for item in result.missing_items if item.get("type") == "question"]
    non_question_missing = [item for item in result.missing_items if item.get("type") != "question"]
    if non_question_missing:
        return result

    required_questions = max(1, math.ceil(total_questions * PREPARED_QUESTION_WRAPUP_MIN_COVERAGE))
    asked_questions = total_questions - len(missing_questions)
    if asked_questions < required_questions:
        return result

    tolerated_marks = [
        (str(item["skill"]), int(item["question_number"]))
        for item in missing_questions
        if item.get("skill") and isinstance(item.get("question_number"), int)
    ]
    verified_marks = list(result.verified_question_marks)
    seen_marks = set(verified_marks)
    for mark in tolerated_marks:
        if mark not in seen_marks:
            verified_marks.append(mark)
            seen_marks.add(mark)

    allowed_missing = total_questions - required_questions
    tolerance_note = (
        f"Prepared-question wrap-up tolerance applied: {len(missing_questions)} of {total_questions} "
        f"questions were still missing, which is within the allowed overall gap of {allowed_missing}."
    )
    notes = result.notes
    if notes:
        notes = f"{notes} {tolerance_note}"
    else:
        notes = tolerance_note

    return PreWrapupVerificationResult(
        verified_question_marks=verified_marks,
        verified_skill_completions=result.verified_skill_completions,
        missing_items=[],
        ready_for_wrapup=True,
        notes=notes,
    )


async def _verify_prepared_question_coverage(
    *,
    plan: InterviewPlan,
    transcript_lines: list[dict],
    provider_cfg: dict,
) -> PreWrapupVerificationResult:
    llm_cfg = provider_cfg.get("llm") or {}
    provider = str(llm_cfg.get("provider") or "").strip().lower()
    api_key = str(llm_cfg.get("api_key") or "").strip()
    model = str(llm_cfg.get("model") or "").strip()
    if not provider or not api_key or not model:
        raise ValueError("LLM provider configuration is missing for pre-wrap-up verification.")

    raw = await _eval_json(
        provider=provider,
        api_key=api_key,
        model=model,
        system=_PREPARED_VERIFY_SYSTEM_PROMPT,
        user=_build_prepared_verification_user_prompt(plan, transcript_lines),
    )
    return _apply_prepared_question_tolerance(_normalize_verification_result(raw, plan), plan)


async def _verify_skills_only_coverage(
    *,
    plan: InterviewPlan,
    transcript_lines: list[dict],
    provider_cfg: dict,
    coverage_exempt_skills: Iterable[str] = (),
) -> PreWrapupVerificationResult:
    llm_cfg = provider_cfg.get("llm") or {}
    provider = str(llm_cfg.get("provider") or "").strip().lower()
    api_key = str(llm_cfg.get("api_key") or "").strip()
    model = str(llm_cfg.get("model") or "").strip()
    if not provider or not api_key or not model:
        raise ValueError("LLM provider configuration is missing for pre-wrap-up verification.")

    raw = await _eval_json(
        provider=provider,
        api_key=api_key,
        model=model,
        system=_SKILLS_VERIFY_SYSTEM_PROMPT,
        user=_build_skills_verification_user_prompt(plan, transcript_lines),
    )
    return _normalize_verification_result(raw, plan, coverage_exempt_skills)


def _build_verification_user_prompt(meta: dict, transcript_lines: list[dict]) -> str:
    """Compatibility wrapper for tests and debugging."""
    plan = resolve_interview_plan(meta.get("interviewMeta") or {})
    if plan.mode == "prepared_questions":
        return _build_prepared_verification_user_prompt(plan, transcript_lines)
    return _build_skills_verification_user_prompt(plan, transcript_lines)


async def verify_pre_wrapup_coverage(
    *,
    meta: dict,
    transcript_lines: list[dict],
    provider_cfg: dict,
    coverage_exempt_skills: Iterable[str] = (),
) -> PreWrapupVerificationResult:
    """Verify whether the active interview plan is actually covered before wrap-up."""
    plan = resolve_interview_plan(meta.get("interviewMeta") or {})
    if not plan.has_plan:
        return PreWrapupVerificationResult(
            verified_question_marks=[],
            verified_skill_completions=[],
            missing_items=[],
            ready_for_wrapup=True,
            notes="No structured plan was provided, so verification is trivially complete.",
        )
    if plan.mode == "prepared_questions":
        return await _verify_prepared_question_coverage(
            plan=plan,
            transcript_lines=transcript_lines,
            provider_cfg=provider_cfg,
        )
    return await _verify_skills_only_coverage(
        plan=plan,
        transcript_lines=transcript_lines,
        provider_cfg=provider_cfg,
        coverage_exempt_skills=coverage_exempt_skills,
    )


__all__ = ["PreWrapupVerificationResult", "verify_pre_wrapup_coverage"]

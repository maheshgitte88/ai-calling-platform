"""Transcript-based verification gate before wrap-up.

This module asks a second LLM pass to compare the live transcript against the
required interview plan so wrap-up only starts after every required item is
actually covered.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from .evaluation import _eval_json, format_transcript_chronological
from .prompt import _normalize_question_groups
from .skills import normalize_skill_specs

_VERIFY_SYSTEM_PROMPT = """
You verify interview-plan coverage before wrap-up. Reply with ONLY valid JSON.

Rules:
- Be strict. If a required question or skill is uncertain, treat it as missing.
- For prepared questions, mark a question verified only if the interviewer clearly asked that question or an unmistakable equivalent in the transcript.
- For skills without prepared questions, mark the skill verified only if there is clear substantive coverage for that skill in the transcript.
- Do not assume coverage from greetings, wrap-up, or vague mentions.
- Use the EXACT skill names and prepared question numbers from the provided plan.

Output JSON shape:
{
  "verifiedPreparedQuestions": [
    { "skill": string, "questionNumbers": [integer] }
  ],
  "verifiedSkills": [string],
  "missingQuestions": [
    { "skill": string, "questionNumber": integer, "question": string }
  ],
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


def _prepared_question_plan(interview_meta: dict) -> list[dict]:
    groups = _normalize_question_groups(interview_meta.get("questions") or [])
    out: list[dict] = []
    for group in groups:
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


def _skills_without_prepared_questions(interview_meta: dict) -> list[str]:
    skill_specs_raw = interview_meta.get("skills") or interview_meta.get("skillWeights") or []
    if not isinstance(skill_specs_raw, list):
        skill_specs_raw = []
    skill_specs = normalize_skill_specs(skill_specs_raw)
    prepared_skill_keys = {
        str(group.get("skill") or "").strip().casefold()
        for group in _normalize_question_groups(interview_meta.get("questions") or [])
        if str(group.get("skill") or "").strip()
    }
    return [
        spec["skill"]
        for spec in skill_specs
        if spec.get("skill") and spec["skill"].casefold() not in prepared_skill_keys
    ]


def _build_verification_user_prompt(meta: dict, transcript_lines: list[dict]) -> str:
    interview_meta = meta.get("interviewMeta") or {}
    prepared_plan = _prepared_question_plan(interview_meta)
    skill_plan = _skills_without_prepared_questions(interview_meta)
    transcript_text = format_transcript_chronological(transcript_lines)

    prepared_lines = ["Prepared questions:"]
    if prepared_plan:
        for group in prepared_plan:
            prepared_lines.append(f"- Skill: {group['skill']}")
            for item in group["questions"]:
                prepared_lines.append(
                    f"  - Question {item['questionNumber']}: {item['question']}"
                )
    else:
        prepared_lines.append("- None")

    skill_lines = ["Required skills without prepared question lists:"]
    if skill_plan:
        skill_lines.extend(f"- {skill}" for skill in skill_plan)
    else:
        skill_lines.append("- None")

    return "\n".join([
        *prepared_lines,
        "",
        *skill_lines,
        "",
        "Transcript:",
        transcript_text,
    ])


def _normalize_verification_result(raw: dict[str, Any]) -> PreWrapupVerificationResult:
    verified_marks: list[tuple[str, int]] = []
    for entry in raw.get("verifiedPreparedQuestions") or []:
        if not isinstance(entry, dict):
            continue
        skill = str(entry.get("skill") or "").strip()
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

    verified_skills = [
        str(skill).strip()
        for skill in (raw.get("verifiedSkills") or [])
        if str(skill).strip()
    ]

    missing_items: list[dict] = []
    for entry in raw.get("missingQuestions") or []:
        if not isinstance(entry, dict):
            continue
        skill = str(entry.get("skill") or "").strip()
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
        skill_name = str(skill).strip()
        if skill_name:
            missing_items.append({"type": "skill", "skill": skill_name})

    return PreWrapupVerificationResult(
        verified_question_marks=verified_marks,
        verified_skill_completions=verified_skills,
        missing_items=missing_items,
        ready_for_wrapup=bool(raw.get("readyForWrapup")) and not missing_items,
        notes=str(raw.get("notes") or "").strip(),
    )


async def verify_pre_wrapup_coverage(
    *,
    meta: dict,
    transcript_lines: list[dict],
    provider_cfg: dict,
) -> PreWrapupVerificationResult:
    """Verify whether the full interview plan is actually covered before wrap-up."""
    interview_meta = meta.get("interviewMeta") or {}
    if not _prepared_question_plan(interview_meta) and not _skills_without_prepared_questions(interview_meta):
        return PreWrapupVerificationResult(
            verified_question_marks=[],
            verified_skill_completions=[],
            missing_items=[],
            ready_for_wrapup=True,
            notes="No structured plan was provided, so verification is trivially complete.",
        )

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
        system=_VERIFY_SYSTEM_PROMPT,
        user=_build_verification_user_prompt(meta, transcript_lines),
    )
    return _normalize_verification_result(raw)


__all__ = ["PreWrapupVerificationResult", "verify_pre_wrapup_coverage"]

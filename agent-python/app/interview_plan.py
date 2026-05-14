"""Normalized interview-plan helpers and flow selection."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from .skills import normalize_skill_specs

PlanMode = Literal["none", "prepared_questions", "skills_only"]


def _parse_weight(raw) -> float | None:
    if isinstance(raw, (int, float)):
        return float(raw)
    if isinstance(raw, str) and raw.strip():
        try:
            return float(raw.strip().replace("%", ""))
        except ValueError:
            return None
    return None


def normalize_question_groups(raw: list) -> list[dict]:
    """Lift ``questions`` payloads into per-skill groups."""
    if not isinstance(raw, list) or not raw:
        return []

    groups: list[dict] = []
    general: list[str] = []

    for item in raw:
        if isinstance(item, str):
            txt = item.strip()
            if txt:
                general.append(txt)
            continue
        if not isinstance(item, dict):
            continue

        skill = str(item.get("skill") or item.get("name") or "").strip()
        if not skill:
            continue

        qs_raw = item.get("questions") or []
        questions = (
            [str(q).strip() for q in qs_raw if str(q).strip()]
            if isinstance(qs_raw, list)
            else []
        )
        if not questions:
            continue

        ask_follow_ups = item.get("askFollowUps")
        if not isinstance(ask_follow_ups, bool):
            ask_follow_ups = True
        allow_additional = item.get("allowAdditional")
        if not isinstance(allow_additional, bool):
            allow_additional = False
        weightage = _parse_weight(item.get("weightage"))
        if weightage is not None:
            weightage = max(0.0, min(100.0, weightage))

        groups.append({
            "skill": skill,
            "questions": questions,
            "ask_follow_ups": ask_follow_ups,
            "allow_additional": allow_additional,
            "weightage": weightage,
        })

    if general:
        groups.append({
            "skill": "General",
            "questions": general,
            "ask_follow_ups": True,
            "allow_additional": False,
            "weightage": None,
        })

    return groups


@dataclass(frozen=True)
class InterviewPlan:
    """Normalized structured interview payload."""

    mode: PlanMode
    question_groups: list[dict]
    skill_specs: list[dict]

    @property
    def has_plan(self) -> bool:
        return self.mode != "none"


def resolve_interview_plan(interview_meta: dict) -> InterviewPlan:
    """Normalize the interview payload and determine its single active mode."""
    question_groups = normalize_question_groups(interview_meta.get("questions") or [])

    skill_specs_raw = interview_meta.get("skills") or interview_meta.get("skillWeights") or []
    if not isinstance(skill_specs_raw, list):
        skill_specs_raw = []
    skill_specs = normalize_skill_specs(skill_specs_raw)

    if question_groups and skill_specs:
        raise ValueError(
            "Interview payload may contain either prepared questions or skills-only configuration, not both."
        )
    if question_groups:
        return InterviewPlan(
            mode="prepared_questions",
            question_groups=question_groups,
            skill_specs=[],
        )
    if skill_specs:
        return InterviewPlan(
            mode="skills_only",
            question_groups=[],
            skill_specs=skill_specs,
        )
    return InterviewPlan(mode="none", question_groups=[], skill_specs=[])


__all__ = ["InterviewPlan", "PlanMode", "normalize_question_groups", "resolve_interview_plan"]

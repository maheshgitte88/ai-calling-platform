"""Runtime interview-plan progress tracking.

This module turns the dispatch payload into a deterministic checklist so the
runtime can detect when the interview plan is complete and start wrap-up
immediately instead of waiting for the full drive timer.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Iterable

from .prompt import _normalize_question_groups
from .skills import normalize_skill_specs


def _skill_key(skill: str) -> str:
    return str(skill).strip().casefold()


@dataclass(frozen=True)
class ProgressUpdate:
    """Result returned by tracker state transitions."""

    accepted: bool
    plan_completed: bool
    message: str


class InterviewProgressTracker:
    """Track completion of the required interview plan.

    Required items come from two sources:
    - Prepared questions (`interviewMeta.questions`) → each question is required.
    - Skills without prepared questions (`interviewMeta.skills`) → the skill must
      be explicitly marked completed after the interviewer has covered it.
    """

    def __init__(self, interview_meta: dict) -> None:
        self.plan_completed: asyncio.Event = asyncio.Event()
        self.completion_requested: asyncio.Event = asyncio.Event()
        self._display_name_by_key: dict[str, str] = {}
        self._required_question_numbers: dict[str, set[int]] = {}
        self._completed_question_numbers: dict[str, set[int]] = {}
        self._required_skill_completions: set[str] = set()
        self._completed_skills: set[str] = set()
        self._skill_order: list[str] = []

        question_groups = _normalize_question_groups(interview_meta.get("questions") or [])

        skill_specs_raw = interview_meta.get("skills") or interview_meta.get("skillWeights") or []
        if not isinstance(skill_specs_raw, list):
            skill_specs_raw = []
        skill_specs = normalize_skill_specs(skill_specs_raw)

        question_skill_keys: set[str] = set()
        for group in question_groups:
            skill = str(group.get("skill") or "").strip()
            if not skill:
                continue
            key = _skill_key(skill)
            self._remember_skill(key, skill)
            question_skill_keys.add(key)
            question_count = len(group.get("questions") or [])
            if question_count <= 0:
                continue
            required = self._required_question_numbers.setdefault(key, set())
            next_index = len(required) + 1
            required.update(range(next_index, next_index + question_count))
            self._completed_question_numbers.setdefault(key, set())

        for spec in skill_specs:
            skill = str(spec.get("skill") or "").strip()
            if not skill:
                continue
            key = _skill_key(skill)
            self._remember_skill(key, skill)
            if key not in question_skill_keys:
                self._required_skill_completions.add(key)

    @property
    def has_plan(self) -> bool:
        """Whether the payload contains any required structured plan items."""
        return bool(self._required_question_numbers or self._required_skill_completions)

    def mark_question_asked(self, skill: str, question_number: int) -> ProgressUpdate:
        """Record that a required prepared question has been asked."""
        key = self._resolve_skill(skill)
        if key not in self._required_question_numbers:
            return ProgressUpdate(
                accepted=False,
                plan_completed=self.plan_completed.is_set(),
                message=(
                    f"Skill '{skill}' does not have required prepared questions in the active interview plan. "
                    "Use mark_skill_completed only for skills without prepared questions."
                ),
            )
        if not isinstance(question_number, int) or question_number <= 0:
            return ProgressUpdate(
                accepted=False,
                plan_completed=self.plan_completed.is_set(),
                message="question_number must be a positive 1-based integer from the prepared question list.",
            )
        required = self._required_question_numbers[key]
        if question_number not in required:
            return ProgressUpdate(
                accepted=False,
                plan_completed=self.plan_completed.is_set(),
                message=(
                    f"Question {question_number} is not part of the required prepared question list for "
                    f"'{self._display_name_by_key[key]}'."
                ),
            )
        completed = self._completed_question_numbers.setdefault(key, set())
        if question_number in completed:
            return ProgressUpdate(
                accepted=True,
                plan_completed=self.plan_completed.is_set(),
                message=(
                    f"Prepared question {question_number} for '{self._display_name_by_key[key]}' was already recorded."
                ),
            )
        completed.add(question_number)
        return ProgressUpdate(
            accepted=True,
            plan_completed=self.plan_completed.is_set(),
            message=self._question_progress_message(key, question_number),
        )

    def mark_skill_completed(self, skill: str) -> ProgressUpdate:
        """Record that a required non-prepared skill has been covered."""
        key = self._resolve_skill(skill)
        if key in self._required_question_numbers:
            return ProgressUpdate(
                accepted=False,
                plan_completed=self.plan_completed.is_set(),
                message=(
                    f"Skill '{self._display_name_by_key[key]}' has required prepared questions. "
                    "Record each prepared question with mark_question_asked instead."
                ),
            )
        if key not in self._required_skill_completions:
            return ProgressUpdate(
                accepted=False,
                plan_completed=self.plan_completed.is_set(),
                message=(
                    f"Skill '{skill}' is not a pending skill-completion item in the active interview plan."
                ),
            )
        if key in self._completed_skills:
            return ProgressUpdate(
                accepted=True,
                plan_completed=self.plan_completed.is_set(),
                message=f"Skill '{self._display_name_by_key[key]}' was already marked completed.",
            )
        self._completed_skills.add(key)
        return ProgressUpdate(
            accepted=True,
            plan_completed=self.plan_completed.is_set(),
            message=self._skill_progress_message(key),
        )

    def confirm_plan_completed(self) -> ProgressUpdate:
        """Request a final runtime verification pass before wrap-up."""
        if not self.has_plan:
            return ProgressUpdate(
                accepted=False,
                plan_completed=False,
                message="No structured interview plan is active, so there is nothing to mark complete.",
            )
        self.completion_requested.set()
        if self.plan_completed.is_set():
            return ProgressUpdate(
                accepted=True,
                plan_completed=True,
                message=(
                    "Interview plan completion has already been verified. Move directly to final candidate questions and close now."
                ),
            )
        return ProgressUpdate(
            accepted=True,
            plan_completed=False,
            message=(
                "Final completion check requested. Wait for runtime verification before entering wrap-up. "
                f"Current tracker state: {self.pending_summary()}."
            ),
        )

    def clear_completion_request(self) -> None:
        """Clear the outstanding runtime verification request."""
        self.completion_requested.clear()

    def authorize_plan_completion(self) -> ProgressUpdate:
        """Release the final wrap-up gate after transcript verification succeeds."""
        if not self.has_plan:
            return ProgressUpdate(
                accepted=False,
                plan_completed=False,
                message="No structured interview plan is active, so wrap-up authorization is not applicable.",
            )
        if not self.is_structurally_complete():
            self.plan_completed.clear()
            return ProgressUpdate(
                accepted=False,
                plan_completed=False,
                message=(
                    "Interview plan is still incomplete after verification. "
                    f"Remaining required items: {self.pending_summary()}."
                ),
            )
        self.plan_completed.set()
        self.completion_requested.clear()
        return ProgressUpdate(
            accepted=True,
            plan_completed=True,
            message="Interview plan completion verified. Wrap-up may begin now.",
        )

    def apply_verified_question_marks(self, marks: Iterable[tuple[str, int]]) -> None:
        """Apply transcript-verified prepared-question coverage without trusting the live model."""
        for raw_skill, question_number in marks:
            key = self._resolve_skill(raw_skill)
            if key not in self._required_question_numbers:
                continue
            if not isinstance(question_number, int) or question_number <= 0:
                continue
            if question_number not in self._required_question_numbers[key]:
                continue
            self._completed_question_numbers.setdefault(key, set()).add(question_number)

    def apply_verified_skill_completions(self, skills: Iterable[str]) -> None:
        """Apply transcript-verified skill coverage without trusting the live model."""
        for raw_skill in skills:
            key = self._resolve_skill(raw_skill)
            if key in self._required_skill_completions:
                self._completed_skills.add(key)

    def is_structurally_complete(self) -> bool:
        """Whether the tracker currently has every required item marked complete."""
        if not self.has_plan:
            return False
        all_questions_done = all(
            required.issubset(self._completed_question_numbers.get(key, set()))
            for key, required in self._required_question_numbers.items()
        )
        all_skills_done = self._required_skill_completions.issubset(self._completed_skills)
        return all_questions_done and all_skills_done

    def missing_items(self) -> list[dict]:
        """Structured list of still-pending required questions and skills."""
        missing: list[dict] = []
        for key in self._skill_order:
            required_questions = self._required_question_numbers.get(key)
            if required_questions:
                question_numbers = sorted(
                    required_questions - self._completed_question_numbers.get(key, set())
                )
                for question_number in question_numbers:
                    missing.append({
                        "type": "question",
                        "skill": self._display_name_by_key[key],
                        "question_number": question_number,
                    })
            if key in self._required_skill_completions and key not in self._completed_skills:
                missing.append({
                    "type": "skill",
                    "skill": self._display_name_by_key[key],
                })
        return missing

    def pending_summary(self) -> str:
        """Human-readable summary of still-pending required items."""
        pending: list[str] = []
        for key in self._skill_order:
            required_questions = self._required_question_numbers.get(key)
            if required_questions:
                missing = sorted(required_questions - self._completed_question_numbers.get(key, set()))
                if missing:
                    missing_str = ", ".join(str(n) for n in missing)
                    pending.append(f"{self._display_name_by_key[key]} questions {missing_str}")
                    continue
            if key in self._required_skill_completions and key not in self._completed_skills:
                pending.append(f"{self._display_name_by_key[key]} coverage")
        return "; ".join(pending) if pending else "none"

    # -- internal ----------------------------------------------------------

    def _remember_skill(self, key: str, display_name: str) -> None:
        if key not in self._display_name_by_key:
            self._display_name_by_key[key] = display_name
        if key not in self._skill_order:
            self._skill_order.append(key)

    def _resolve_skill(self, raw_skill: str) -> str:
        skill = str(raw_skill or "").strip()
        key = _skill_key(skill)
        if key and key not in self._display_name_by_key:
            self._display_name_by_key[key] = skill
            self._skill_order.append(key)
        return key

    def _question_progress_message(self, key: str, question_number: int) -> str:
        missing = sorted(
            self._required_question_numbers[key] - self._completed_question_numbers.get(key, set())
        )
        if missing:
            missing_str = ", ".join(str(n) for n in missing)
            return (
                f"Recorded prepared question {question_number} for '{self._display_name_by_key[key]}'. "
                f"Remaining required questions for this skill: {missing_str}. "
                f"Overall pending items: {self.pending_summary()}."
            )
        return (
            f"Recorded prepared question {question_number} for '{self._display_name_by_key[key]}'. "
            f"That skill's required prepared list is complete. Overall pending items: {self.pending_summary()}."
        )

    def _skill_progress_message(self, key: str) -> str:
        return (
            f"Recorded skill completion for '{self._display_name_by_key[key]}'. "
            f"Overall pending items: {self.pending_summary()}."
        )


__all__ = ["InterviewProgressTracker", "ProgressUpdate"]

"""Runtime interview-plan progress tracking."""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from typing import Iterable

from .interview_plan import InterviewPlan, PlanMode, resolve_interview_plan
from .metadata import compute_durations
from .skills import canonical_skill_key

logger = logging.getLogger(__name__)


def _skill_key(skill: str) -> str:
    return canonical_skill_key(skill)


@dataclass(frozen=True)
class ProgressUpdate:
    """Result returned by tracker state transitions."""

    accepted: bool
    plan_completed: bool
    message: str


@dataclass
class SkillRuntimeState:
    """Runtime pacing state for one skills-only interview skill."""

    allocated_seconds: float
    min_required_seconds: float
    started_at_monotonic: float | None = None
    consecutive_nonresponses: int = 0
    completion_reason: str | None = None
    auto_completed_via_nonresponse: bool = False


class _BaseProgressTracker:
    def __init__(self, plan_mode: PlanMode) -> None:
        self.plan_mode = plan_mode
        self.plan_completed: asyncio.Event = asyncio.Event()
        self.completion_requested: asyncio.Event = asyncio.Event()
        self._manual_completion_requested = False
        self._runtime_completion_requested = False

    @property
    def has_plan(self) -> bool:
        return self.plan_mode != "none"

    @property
    def skills_only_mode(self) -> bool:
        return self.plan_mode == "skills_only"

    def mark_question_asked(self, skill: str, question_number: int) -> ProgressUpdate:
        del skill, question_number
        return ProgressUpdate(
            accepted=False,
            plan_completed=self.plan_completed.is_set(),
            message="No prepared-question flow is active in this interview plan.",
        )

    def mark_skill_completed(self, skill: str) -> ProgressUpdate:
        del skill
        return ProgressUpdate(
            accepted=False,
            plan_completed=self.plan_completed.is_set(),
            message="No skills-only flow is active in this interview plan.",
        )

    def confirm_plan_completed(self) -> ProgressUpdate:
        if not self.has_plan:
            return ProgressUpdate(
                accepted=False,
                plan_completed=False,
                message="No structured interview plan is active, so there is nothing to mark complete.",
            )
        if not self._manual_completion_requested:
            logger.info(
                "[InterviewProgress] Manual completion requested.",
                extra={
                    "plan_mode": self.plan_mode,
                    "pending_summary": self.pending_summary(),
                    "runtime_gate_summary": self.runtime_gate_summary(),
                },
            )
        self._manual_completion_requested = True
        self._sync_completion_requested_event()
        if self.plan_completed.is_set():
            return ProgressUpdate(
                accepted=True,
                plan_completed=True,
                message="Interview plan completion has already been verified. Wait for runtime wrap-up instructions.",
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
        if self._manual_completion_requested or self._runtime_completion_requested:
            logger.info(
                "[InterviewProgress] Clearing completion request state.",
                extra=self.completion_request_debug_state(),
            )
        self._manual_completion_requested = False
        self._runtime_completion_requested = False
        self._sync_completion_requested_event()

    def authorize_plan_completion(self) -> ProgressUpdate:
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
        runtime_summary = self.runtime_gate_summary()
        if runtime_summary != "none":
            self.plan_completed.clear()
            self._manual_completion_requested = False
            self._runtime_completion_requested = False
            self._sync_completion_requested_event()
            gate_label = (
                "skills-only pacing gate"
                if self.plan_mode == "skills_only"
                else "runtime pacing gate"
            )
            return ProgressUpdate(
                accepted=False,
                plan_completed=False,
                message=(
                    f"Interview plan is structurally complete, but the {gate_label} is still active. "
                    f"Remaining runtime requirements: {runtime_summary}."
                ),
            )
        self.plan_completed.set()
        self._manual_completion_requested = False
        self._runtime_completion_requested = False
        self._sync_completion_requested_event()
        return ProgressUpdate(
            accepted=True,
            plan_completed=True,
            message="Interview plan completion verified. Wrap-up may begin now.",
        )

    def apply_verified_question_marks(self, marks: Iterable[tuple[str, int]]) -> None:
        del marks

    def apply_verified_skill_completions(self, skills: Iterable[str]) -> None:
        del skills

    def is_structurally_complete(self) -> bool:
        return False

    def missing_items(self) -> list[dict]:
        return []

    def pending_summary(self) -> str:
        return "none"

    def note_candidate_response(self, text: str) -> None:
        del text

    def runtime_gate_blockers(self) -> list[dict]:
        return []

    def runtime_gate_summary(self) -> str:
        return "none"

    def verifier_exempt_skill_names(self) -> list[str]:
        return []

    def completion_request_debug_state(self) -> dict:
        return {
            "plan_mode": self.plan_mode,
            "manual_completion_requested": self._manual_completion_requested,
            "runtime_completion_requested": self._runtime_completion_requested,
            "pending_summary": self.pending_summary(),
            "runtime_gate_summary": self.runtime_gate_summary(),
        }

    def _sync_completion_requested_event(self) -> None:
        if self._manual_completion_requested or self._runtime_completion_requested:
            self.completion_requested.set()
        else:
            self.completion_requested.clear()


class _NoPlanProgressTracker(_BaseProgressTracker):
    def __init__(self) -> None:
        super().__init__("none")


class _PreparedQuestionsProgressTracker(_BaseProgressTracker):
    def __init__(self, plan: InterviewPlan) -> None:
        super().__init__("prepared_questions")
        self._display_name_by_key: dict[str, str] = {}
        self._required_question_numbers: dict[str, set[int]] = {}
        self._completed_question_numbers: dict[str, set[int]] = {}
        self._skill_order: list[str] = []

        for group in plan.question_groups:
            skill = str(group.get("skill") or "").strip()
            if not skill:
                continue
            key = _skill_key(skill)
            self._remember_skill(key, skill)
            question_count = len(group.get("questions") or [])
            if question_count <= 0:
                continue
            self._required_question_numbers[key] = set(range(1, question_count + 1))
            self._completed_question_numbers.setdefault(key, set())

    def mark_question_asked(self, skill: str, question_number: int) -> ProgressUpdate:
        key = self._resolve_skill(skill)
        if key not in self._required_question_numbers:
            return ProgressUpdate(
                accepted=False,
                plan_completed=self.plan_completed.is_set(),
                message=(
                    f"Skill '{skill}' does not have required prepared questions in the active interview plan."
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
        key = self._resolve_skill(skill)
        if key in self._required_question_numbers:
            return ProgressUpdate(
                accepted=False,
                plan_completed=self.plan_completed.is_set(),
                message=(
                    f"Skill '{self._display_name_by_key[key]}' is tracked through prepared questions. "
                    "Record each prepared question with mark_question_asked instead."
                ),
            )
        return super().mark_skill_completed(skill)

    def apply_verified_question_marks(self, marks: Iterable[tuple[str, int]]) -> None:
        for raw_skill, question_number in marks:
            key = self._resolve_skill(raw_skill)
            if key not in self._required_question_numbers:
                continue
            if not isinstance(question_number, int) or question_number <= 0:
                continue
            if question_number not in self._required_question_numbers[key]:
                continue
            self._completed_question_numbers.setdefault(key, set()).add(question_number)

    def is_structurally_complete(self) -> bool:
        return all(
            required.issubset(self._completed_question_numbers.get(key, set()))
            for key, required in self._required_question_numbers.items()
        )

    def missing_items(self) -> list[dict]:
        missing: list[dict] = []
        for key in self._skill_order:
            required_questions = self._required_question_numbers.get(key)
            if not required_questions:
                continue
            for question_number in sorted(required_questions - self._completed_question_numbers.get(key, set())):
                missing.append({
                    "type": "question",
                    "skill": self._display_name_by_key[key],
                    "question_number": question_number,
                })
        return missing

    def pending_summary(self) -> str:
        pending: list[str] = []
        for key in self._skill_order:
            required_questions = self._required_question_numbers.get(key)
            if not required_questions:
                continue
            missing = sorted(required_questions - self._completed_question_numbers.get(key, set()))
            if missing:
                pending.append(
                    f"{self._display_name_by_key[key]} questions {', '.join(str(n) for n in missing)}"
                )
        return "; ".join(pending) if pending else "none"

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
            return (
                f"Recorded prepared question {question_number} for '{self._display_name_by_key[key]}'. "
                f"Remaining required questions for this skill: {', '.join(str(n) for n in missing)}. "
                f"Overall pending items: {self.pending_summary()}."
            )
        return (
            f"Recorded prepared question {question_number} for '{self._display_name_by_key[key]}'. "
            f"That skill's required prepared list is complete. Overall pending items: {self.pending_summary()}."
        )


class _SkillsOnlyProgressTracker(_BaseProgressTracker):
    def __init__(self, plan: InterviewPlan, interview_meta: dict) -> None:
        super().__init__("skills_only")
        self._display_name_by_key: dict[str, str] = {}
        self._required_skill_completions: set[str] = set()
        self._completed_skills: set[str] = set()
        self._skill_order: list[str] = []
        self._skills_only_min_fraction = 0.75
        self._nonresponse_threshold = 4
        self._active_skill_key: str | None = None
        self._runtime_state_by_key: dict[str, SkillRuntimeState] = {}

        for spec in plan.skill_specs:
            skill = str(spec.get("skill") or "").strip()
            if not skill:
                continue
            key = _skill_key(skill)
            self._remember_skill(key, skill)
            self._required_skill_completions.add(key)

        self._init_skills_only_runtime(plan.skill_specs, interview_meta)

    def mark_skill_completed(self, skill: str) -> ProgressUpdate:
        key = self._resolve_skill(skill)
        if key not in self._required_skill_completions:
            return ProgressUpdate(
                accepted=False,
                plan_completed=self.plan_completed.is_set(),
                message=f"Skill '{skill}' is not a pending skills-only item in the active interview plan.",
            )
        if key in self._completed_skills:
            return ProgressUpdate(
                accepted=True,
                plan_completed=self.plan_completed.is_set(),
                message=f"Skill '{self._display_name_by_key[key]}' was already marked completed.",
            )
        blocker = self.runtime_gate_blockers_for_skill(key)
        if blocker is not None:
            return ProgressUpdate(
                accepted=False,
                plan_completed=self.plan_completed.is_set(),
                message=self._skill_timing_gate_message(key, blocker),
            )
        self._completed_skills.add(key)
        self._activate_next_skill()
        return ProgressUpdate(
            accepted=True,
            plan_completed=self.plan_completed.is_set(),
            message=self._skill_progress_message(key),
        )

    def apply_verified_skill_completions(self, skills: Iterable[str]) -> None:
        for raw_skill in skills:
            key = self._resolve_skill(raw_skill)
            if key in self._required_skill_completions:
                self._completed_skills.add(key)

    def is_structurally_complete(self) -> bool:
        return self._required_skill_completions.issubset(self._completed_skills)

    def missing_items(self) -> list[dict]:
        missing: list[dict] = []
        for key in self._skill_order:
            if key in self._required_skill_completions and key not in self._completed_skills:
                missing.append({"type": "skill", "skill": self._display_name_by_key[key]})
        return missing

    def pending_summary(self) -> str:
        pending = [
            f"{self._display_name_by_key[key]} coverage"
            for key in self._skill_order
            if key in self._required_skill_completions and key not in self._completed_skills
        ]
        return "; ".join(pending) if pending else "none"

    def note_candidate_response(self, text: str) -> None:
        key = self._ensure_active_skill_started()
        if not key:
            return
        state = self._runtime_state_by_key.get(key)
        if state is None:
            return
        if self._is_nonresponse(text):
            state.consecutive_nonresponses += 1
        else:
            state.consecutive_nonresponses = 0
        self._refresh_runtime_eligibility(key)
        self._sync_runtime_nonresponse_wrapup_request(key)

    def runtime_gate_blockers(self) -> list[dict]:
        blockers: list[dict] = []
        for key in self._skill_order:
            if key not in self._required_skill_completions:
                continue
            blocker = self.runtime_gate_blockers_for_skill(key)
            if blocker is not None:
                blockers.append(blocker)
        return blockers

    def runtime_gate_blockers_for_skill(self, key: str) -> dict | None:
        state = self._runtime_state_by_key.get(key)
        if state is None:
            return None
        self._refresh_runtime_eligibility(key)
        if state.completion_reason is not None:
            return None
        elapsed = self._skill_elapsed_seconds(key)
        return {
            "type": "skill_timing",
            "skill": self._display_name_by_key[key],
            "remaining_seconds": max(0.0, state.min_required_seconds - elapsed),
            "elapsed_seconds": elapsed,
            "min_required_seconds": state.min_required_seconds,
            "consecutive_nonresponses": state.consecutive_nonresponses,
            "nonresponse_threshold": self._nonresponse_threshold,
        }

    def runtime_gate_summary(self) -> str:
        blockers = self.runtime_gate_blockers()
        if not blockers:
            return "none"
        return "; ".join(
            (
                f"{blocker['skill']} needs about {blocker['remaining_seconds'] / 60.0:.1f} more min "
                f"or {self._nonresponse_threshold} consecutive non-responses "
                f"(current streak: {blocker['consecutive_nonresponses']})"
            )
            for blocker in blockers
        )

    def verifier_exempt_skill_names(self) -> list[str]:
        if len(self._required_skill_completions) != 1:
            return []
        only_key = next(iter(self._required_skill_completions), "")
        if not only_key:
            return []
        state = self._runtime_state_by_key.get(only_key)
        self._refresh_runtime_eligibility(only_key)
        if state and state.completion_reason == "nonresponse_threshold":
            return [self._display_name_by_key[only_key]]
        return []

    def completion_request_debug_state(self) -> dict:
        active_key = self._active_skill_key
        active_state = self._runtime_state_by_key.get(active_key or "")
        active_skill = self._display_name_by_key.get(active_key or "", "") if active_key else ""
        if active_key:
            self._refresh_runtime_eligibility(active_key)
            active_state = self._runtime_state_by_key.get(active_key or "")
        state = super().completion_request_debug_state()
        state.update({
            "active_skill": active_skill or None,
            "active_skill_completion_reason": active_state.completion_reason if active_state else None,
            "active_skill_consecutive_nonresponses": (
                active_state.consecutive_nonresponses if active_state else None
            ),
        })
        return state

    def _init_skills_only_runtime(self, skill_specs: list[dict], interview_meta: dict) -> None:
        total_seconds = float(compute_durations(interview_meta).total_seconds)
        weighted: list[tuple[str, float]] = []
        unweighted: list[str] = []
        for spec in skill_specs:
            skill = str(spec.get("skill") or "").strip()
            if not skill:
                continue
            key = _skill_key(skill)
            if key not in self._required_skill_completions:
                continue
            weight = spec.get("weightage")
            if isinstance(weight, float) and weight > 0:
                weighted.append((key, weight))
            else:
                unweighted.append(key)

        share_by_key: dict[str, float] = {}
        if weighted:
            total_weight = sum(weight for _, weight in weighted)
            if unweighted and total_weight < 100.0:
                per_unweighted_share = max(0.0, 100.0 - total_weight) / 100.0 / len(unweighted)
                for key, weight in weighted:
                    share_by_key[key] = weight / 100.0
                for key in unweighted:
                    share_by_key[key] = per_unweighted_share
            else:
                normalizer = total_weight if total_weight > 0 else float(len(weighted))
                for key, weight in weighted:
                    share_by_key[key] = weight / normalizer
                for key in unweighted:
                    share_by_key[key] = 0.0
        elif self._required_skill_completions:
            equal_share = 1.0 / len(self._required_skill_completions)
            for key in self._required_skill_completions:
                share_by_key[key] = equal_share

        for key in self._required_skill_completions:
            share = share_by_key.get(key, 0.0)
            allocated_seconds = (
                total_seconds * share
                if share > 0
                else total_seconds / max(1, len(self._required_skill_completions))
            )
            self._runtime_state_by_key[key] = SkillRuntimeState(
                allocated_seconds=allocated_seconds,
                min_required_seconds=allocated_seconds * self._skills_only_min_fraction,
            )

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

    def _activate_next_skill(self) -> None:
        next_key = None
        for key in self._skill_order:
            if key in self._required_skill_completions and key not in self._completed_skills:
                next_key = key
                break
        self._active_skill_key = next_key
        if next_key:
            self._ensure_active_skill_started()

    def _skill_progress_message(self, key: str) -> str:
        return (
            f"Recorded skill completion for '{self._display_name_by_key[key]}'. "
            f"Overall pending items: {self.pending_summary()}."
        )

    def _ensure_active_skill_started(self) -> str | None:
        if self._active_skill_key is None or self._active_skill_key in self._completed_skills:
            for key in self._skill_order:
                if key in self._required_skill_completions and key not in self._completed_skills:
                    self._active_skill_key = key
                    break
        key = self._active_skill_key
        if not key:
            return None
        state = self._runtime_state_by_key.get(key)
        if state and state.started_at_monotonic is None:
            state.started_at_monotonic = self._now_monotonic()
        return key

    def _skill_elapsed_seconds(self, key: str) -> float:
        state = self._runtime_state_by_key.get(key)
        if state is None or state.started_at_monotonic is None:
            return 0.0
        return max(0.0, self._now_monotonic() - state.started_at_monotonic)

    def _refresh_runtime_eligibility(self, key: str) -> None:
        state = self._runtime_state_by_key.get(key)
        if state is None:
            return
        state.completion_reason = self._current_completion_reason(key)

    def _current_completion_reason(self, key: str) -> str | None:
        state = self._runtime_state_by_key.get(key)
        if state is None:
            return None
        if self._skill_elapsed_seconds(key) >= state.min_required_seconds:
            return "time_gate_met"
        if state.consecutive_nonresponses >= self._nonresponse_threshold:
            return "nonresponse_threshold"
        return None

    def _sync_runtime_nonresponse_wrapup_request(self, key: str) -> None:
        state = self._runtime_state_by_key.get(key)
        if state is None:
            return
        previously_requested = self._runtime_completion_requested
        should_request = (
            len(self._required_skill_completions) == 1
            and key in self._required_skill_completions
            and state.completion_reason == "nonresponse_threshold"
            and not self.plan_completed.is_set()
        )
        if should_request:
            self._completed_skills.add(key)
            state.auto_completed_via_nonresponse = True
            self._runtime_completion_requested = True
            if not previously_requested:
                logger.info(
                    "[InterviewProgress] Runtime completion requested by nonresponse threshold.",
                    extra={
                        "plan_mode": self.plan_mode,
                        "skill": self._display_name_by_key.get(key, key),
                        "consecutive_nonresponses": state.consecutive_nonresponses,
                        "nonresponse_threshold": self._nonresponse_threshold,
                        "pending_summary": self.pending_summary(),
                    },
                )
            self._sync_completion_requested_event()
            return
        if state.auto_completed_via_nonresponse:
            self._completed_skills.discard(key)
            state.auto_completed_via_nonresponse = False
            logger.info(
                "[InterviewProgress] Runtime nonresponse completion request cleared after candidate response.",
                extra={
                    "plan_mode": self.plan_mode,
                    "skill": self._display_name_by_key.get(key, key),
                    "consecutive_nonresponses": state.consecutive_nonresponses,
                    "nonresponse_threshold": self._nonresponse_threshold,
                    "runtime_gate_summary": self.runtime_gate_summary(),
                },
            )
        self._runtime_completion_requested = False
        self._sync_completion_requested_event()

    def _skill_timing_gate_message(self, key: str, blocker: dict) -> str:
        remaining_minutes = blocker["remaining_seconds"] / 60.0
        return (
            f"Runtime control: completion denied for skill '{self._display_name_by_key[key]}'. "
            f"Continue normal technical questioning on this skill. Do not mention wrap-up, time remaining, "
            f"countdowns, final questions, or closing to the candidate. Internal pacing note: about "
            f"{remaining_minutes:.1f} more minutes remain unless the candidate reaches "
            f"{self._nonresponse_threshold} consecutive non-responses. Current non-response streak: "
            f"{blocker['consecutive_nonresponses']}."
        )

    @staticmethod
    def _now_monotonic() -> float:
        try:
            return asyncio.get_running_loop().time()
        except RuntimeError:
            return time.monotonic()

    @staticmethod
    def _is_nonresponse(text: str) -> bool:
        body = str(text or "").strip().casefold()
        if not body:
            return True
        exact = {
            "i don't know",
            "i dont know",
            "don't know",
            "dont know",
            "not sure",
            "no idea",
            "skip",
            "pass",
        }
        if body in exact:
            return True
        phrases = (
            "i don't know",
            "i dont know",
            "do not know",
            "not sure",
            "no idea",
            "can't answer",
            "cannot answer",
            "skip this",
            "pass this",
        )
        return any(phrase in body for phrase in phrases)


class InterviewProgressTracker:
    """Facade over the active interview-plan progress tracker."""

    def __init__(self, interview_meta: dict) -> None:
        self.plan = resolve_interview_plan(interview_meta)
        if self.plan.mode == "prepared_questions":
            self._impl = _PreparedQuestionsProgressTracker(self.plan)
        elif self.plan.mode == "skills_only":
            self._impl = _SkillsOnlyProgressTracker(self.plan, interview_meta)
        else:
            self._impl = _NoPlanProgressTracker()

    @property
    def plan_mode(self) -> PlanMode:
        return self._impl.plan_mode

    def __getattr__(self, name: str):
        return getattr(self._impl, name)


__all__ = ["InterviewProgressTracker", "ProgressUpdate", "SkillRuntimeState"]

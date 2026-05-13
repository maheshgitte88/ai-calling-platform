"""End-to-end interview session orchestration + worker entrypoint.

This module deliberately stays as the only place where the various app
sub-modules are stitched together; everything else is a small helper or
data class with a single responsibility.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Callable
from uuid import uuid4

from livekit.agents import AgentSession, ChatContext, ChatMessage, JobContext, room_io
from livekit.agents.llm import ToolError, function_tool
from livekit.agents.llm.tool_context import ToolFlag
from livekit.agents.voice import Agent, RunContext

from providers.llm import get_llm
from providers.stt import get_stt
from providers.tts import get_tts

from .avatar import maybe_attach_avatar
from .config import Settings, settings as default_settings
from .db import get_db
from .evaluation import generate_structured_evaluation
from .interview_memory import InterviewMemoryState, build_compact_chat_context
from .interview_progress import InterviewProgressTracker
from .metadata import InterviewDurations, compute_durations, parse_metadata
from .pre_wrapup_verifier import verify_pre_wrapup_coverage
from .prompt import build_interview_memory_message, build_prompt, build_runtime_control_message
from .provider_resolver import resolve_provider_cfg
from .time_utils import now_iso
from .transcript import TranscriptRecorder

logger = logging.getLogger(__name__)

EXPECTED_MODE = "video_interview"
CANDIDATE_JOIN_TIMEOUT_SECONDS = 10 * 60
RECONNECT_GRACE_SECONDS = 90


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _iso_after(seconds: int) -> str:
    return (_utc_now() + timedelta(seconds=max(0, int(seconds)))).isoformat()


def _wrap_up_instruction_text(seconds: int) -> str:
    if seconds >= 120 and seconds % 60 == 0:
        minutes = seconds // 60
        unit = "minute" if minutes == 1 else "minutes"
        countdown = f"the final {minutes} {unit}"
    else:
        countdown = f"the final {max(1, int(seconds))} seconds"
    return (
        f"Wrap-up is now explicitly authorized. Clearly tell the candidate that {countdown} have started. "
        "From this point onward, do not ask any new substantive technical interview questions. "
        "Ask one concise final check question only if absolutely essential, then ask whether the candidate "
        "has any final questions. Respond briefly and conclude politely before the countdown ends."
    )


def _missing_items_retry_instruction(missing_items: list[dict], notes: str = "") -> str:
    """Tell the interviewer exactly what still needs to be covered before wrap-up."""
    lines = [
        "Runtime control: wrap-up is not authorized.",
        "A transcript verification pass found required interview items that are still missing or uncertain.",
        "Continue normal technical interviewing now and cover only these missing required items first.",
        "Do not mention wrap-up, time remaining, countdowns, final questions, or closing to the candidate.",
    ]
    question_items = [item for item in missing_items if item.get("type") == "question"]
    skill_items = [item for item in missing_items if item.get("type") == "skill"]

    if question_items:
        lines.append("Missing required prepared questions:")
        for item in question_items:
            question_text = str(item.get("question") or "").strip()
            lines.append(
                f"- Skill '{item['skill']}', question {item['question_number']}: ask this prepared question now: {question_text}"
            )
    if skill_items:
        lines.append("Missing required skill coverage:")
        for item in skill_items:
            lines.append(
                f"- Skill '{item['skill']}': ask a concise substantive question on this skill now."
            )
    lines.extend([
        "Do not repeat already covered sections unless needed for the missing item itself.",
        "Ask the next technical question immediately instead of using any closing language.",
        "After you cover each missing item, call the progress tools again.",
        "Only after all missing items are covered should you call `mark_interview_plan_completed` again to request another verification pass.",
    ])
    if notes:
        lines.append(f"Verifier notes: {notes}")
    return "\n".join(lines)


def _skills_only_gate_retry_instruction(blockers: list[dict]) -> str:
    """Tell the interviewer to keep probing a skills-only interview before wrap-up."""
    lines = [
        "Runtime control: wrap-up is not authorized.",
        "Completion was denied because the skills-only pacing gate is still active.",
        "Continue normal technical interviewing on the current skill now.",
        "Do not mention wrap-up, time remaining, countdowns, final questions, or closing to the candidate.",
        "Ask the next technical question immediately and keep probing the same skill with fresh conceptual and practical questions.",
    ]
    for blocker in blockers:
        lines.append(
            f"- Skill '{blocker['skill']}': continue this skill until runtime later accepts completion or the candidate reaches "
            f"{blocker['nonresponse_threshold']} consecutive non-responses. Current non-response streak: "
            f"{blocker['consecutive_nonresponses']}."
        )
    lines.extend([
        "Do not call `mark_skill_completed` for that skill again immediately after this message.",
        "After the remaining pacing requirement is satisfied, request completion again.",
    ])
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _initial_reply_instructions() -> str:
    """Kickoff turn: greet + readiness check only. Do NOT ask the first question yet."""
    return "Give a short greeting and ask if the candidate is ready to begin. Do not ask the first interview question yet."


def _candidate_identity(candidate_id: str) -> str:
    return f"candidate_{candidate_id}" if candidate_id else ""


def _is_candidate(identity: str, expected: str) -> bool:
    if expected:
        return identity == expected
    return identity.startswith("candidate_")


def _basic_signals_from_stats(stats: dict[str, Any]) -> tuple[list[str], list[str]]:
    """Derive coarse strengths/gaps tags from the question-stats counters."""
    strengths: list[str] = []
    gaps: list[str] = []
    n = int(stats.get("total") or 0)
    if n <= 0:
        return strengths, gaps

    correct = int(stats.get("correct") or 0)
    partial = int(stats.get("partially_correct") or 0)
    weak = int(stats.get("weak") or 0)
    incorrect = int(stats.get("incorrect") or 0)
    no_answer = int(stats.get("could_not_answer") or 0)

    half = max(1, n // 2)
    if correct >= half:
        strengths.append("Solid accuracy on multiple interview questions.")
    elif (correct + partial) >= half:
        strengths.append("Showed partial understanding on several questions.")
    if weak > 0:
        gaps.append("Some answers showed awareness but were substantially incomplete.")
    if (weak + incorrect + no_answer) > n // 2:
        gaps.append("Several questions were weak, incorrect, or unanswered.")

    return strengths, gaps


class _BaseInterviewAgent(Agent):
    """Interview agent with shared runtime completion tooling."""

    def __init__(
        self,
        *,
        instructions: str,
        stt: Any,
        llm: Any,
        tts: Any,
        progress_tracker: InterviewProgressTracker,
        transcript: TranscriptRecorder,
        memory_state: InterviewMemoryState,
        runtime_control_provider: Callable[[], str | None],
        wrap_up_authorized_provider: Callable[[], bool],
    ) -> None:
        super().__init__(instructions=instructions, stt=stt, llm=llm, tts=tts)
        self._base_prompt = instructions
        self._progress_tracker = progress_tracker
        self._transcript = transcript
        self._memory_state = memory_state
        self._runtime_control_provider = runtime_control_provider
        self._wrap_up_authorized_provider = wrap_up_authorized_provider

    def _build_compact_turn_context(self, source_ctx: ChatContext) -> ChatContext:
        self._memory_state.refresh_from_transcript(self._transcript.lines)
        return build_compact_chat_context(
            source_ctx=source_ctx,
            base_instructions=self._base_prompt,
            memory_message=build_interview_memory_message(
                earlier_summary=self._memory_state.summary_text,
                pending_summary=self._progress_tracker.pending_summary(),
                runtime_gate_summary=self._progress_tracker.runtime_gate_summary(),
                anti_repeat_summary=self._progress_tracker.anti_repeat_summary(),
                wrap_up_authorized=self._wrap_up_authorized_provider(),
            ),
            runtime_control=self._runtime_control_provider(),
            max_tail_items=self._memory_state.max_tail_items,
        )

    async def on_user_turn_completed(
        self,
        turn_ctx: ChatContext,
        new_message: ChatMessage,
    ) -> None:
        del new_message
        turn_ctx.items[:] = self._build_compact_turn_context(turn_ctx).items

    @function_tool(flags=ToolFlag.IGNORE_ON_ENTER)
    async def mark_interview_plan_completed(self, context: RunContext) -> str:
        """Validate whether all required interview items are complete and wrap-up should begin now."""
        del context
        update = self._progress_tracker.confirm_plan_completed()
        if not update.accepted:
            raise ToolError(update.message)
        return update.message


class PreparedQuestionsInterviewAgent(_BaseInterviewAgent):
    """Interview agent for prepared-question flow."""

    @function_tool(flags=ToolFlag.IGNORE_ON_ENTER)
    async def mark_question_asked(
        self,
        context: RunContext,
        skill: str,
        question_number: int,
    ) -> str:
        """Record that you have just asked one required prepared question.

        Args:
            skill: Exact skill name from the prepared-question section.
            question_number: 1-based question number inside that skill's prepared list.
        """
        del context
        update = self._progress_tracker.mark_question_asked(skill, question_number)
        if not update.accepted:
            raise ToolError(update.message)
        return update.message


class SkillsOnlyInterviewAgent(_BaseInterviewAgent):
    """Interview agent for skills-only flow."""

    @function_tool(flags=ToolFlag.IGNORE_ON_ENTER)
    async def mark_skill_completed(self, context: RunContext, skill: str) -> str:
        """Record that you have finished covering one required skill with no prepared question list.

        Args:
            skill: Exact skill name from the skill plan.
        """
        del context
        update = self._progress_tracker.mark_skill_completed(skill)
        if not update.accepted:
            raise ToolError(update.message)
        return update.message


def _persist_candidate_connected(
    db: Any,
    session_id: str,
    *,
    first_join: bool = False,
) -> None:
    updates = {
        "candidate_connection_status": "connected",
        "last_candidate_connected_at": now_iso(),
        "reconnect_grace_started_at": None,
        "reconnect_grace_ends_at": None,
        "updated_at": now_iso(),
    }
    if first_join:
        updates["started_at"] = now_iso()
        updates["status"] = "in_progress"
    db.interview_sessions.update_one({"session_id": session_id}, {"$set": updates})


def _persist_candidate_disconnected(db: Any, session_id: str, *, grace_seconds: int) -> str:
    grace_ends_at = _iso_after(grace_seconds)
    db.interview_sessions.update_one(
        {"session_id": session_id},
        {"$set": {
            "candidate_connection_status": "disconnected",
            "last_candidate_disconnected_at": now_iso(),
            "reconnect_grace_started_at": now_iso(),
            "reconnect_grace_ends_at": grace_ends_at,
            "updated_at": now_iso(),
        }},
    )
    return grace_ends_at


def _persist_wrap_up_started(
    db: Any,
    session_id: str,
    *,
    wrap_up_seconds: int,
    reason: str,
) -> str:
    wrap_up_ends_at = _iso_after(wrap_up_seconds)
    db.interview_sessions.update_one(
        {"session_id": session_id},
        {"$set": {
            "status": "wrap_up",
            "wrap_up_started_at": now_iso(),
            "wrap_up_ends_at": wrap_up_ends_at,
            "wrap_up_reason": reason,
            "updated_at": now_iso(),
        }},
    )
    return wrap_up_ends_at


def _persist_session_completed(
    db: Any,
    session_id: str,
    *,
    ended_reason: str,
) -> None:
    db.interview_sessions.update_one(
        {"session_id": session_id},
        {"$set": {
            "status": "completed",
            "ended_reason": ended_reason,
            "completed_at": now_iso(),
            "reconnect_grace_started_at": None,
            "reconnect_grace_ends_at": None,
            "updated_at": now_iso(),
        }},
    )


async def _wait_for_drive_outcome(
    *,
    tracker: "CandidateRoomTracker",
    completion_requested: asyncio.Event,
    drive_seconds: int,
) -> str:
    """Wait for the first interview-ending condition.

    Returns one of: ``candidate_disconnected``, ``completion_requested``, ``timeout``.
    """
    disconnect_task = asyncio.create_task(tracker.disconnected.wait())
    completion_requested_task = asyncio.create_task(completion_requested.wait())
    timeout_task = asyncio.create_task(asyncio.sleep(drive_seconds))

    try:
        done, pending = await asyncio.wait(
            {disconnect_task, completion_requested_task, timeout_task},
            return_when=asyncio.FIRST_COMPLETED,
        )
    finally:
        for task in (disconnect_task, completion_requested_task, timeout_task):
            if task.done():
                continue
            task.cancel()
        await asyncio.gather(
            disconnect_task,
            completion_requested_task,
            timeout_task,
            return_exceptions=True,
        )

    if tracker.disconnected.is_set():
        return "candidate_disconnected"
    if completion_requested.is_set() and completion_requested_task in done:
        return "completion_requested"
    return "timeout"


async def _wait_for_reconnect(
    *,
    tracker: "CandidateRoomTracker",
    timeout_seconds: float,
) -> str:
    """Wait for the candidate to reconnect within the grace window."""
    reconnect_task = asyncio.create_task(tracker.connected.wait())
    timeout_task = asyncio.create_task(asyncio.sleep(max(0.0, timeout_seconds)))
    try:
        done, _ = await asyncio.wait(
            {reconnect_task, timeout_task},
            return_when=asyncio.FIRST_COMPLETED,
        )
    finally:
        for task in (reconnect_task, timeout_task):
            if task.done():
                continue
            task.cancel()
        await asyncio.gather(reconnect_task, timeout_task, return_exceptions=True)

    if tracker.connected.is_set() and reconnect_task in done:
        return "candidate_reconnected"
    return "timeout"


def _build_scripted_reply_chat_ctx(
    *,
    session: AgentSession,
    base_prompt: str,
    transcript: TranscriptRecorder,
    progress_tracker: InterviewProgressTracker,
    memory_state: InterviewMemoryState,
    runtime_control_provider: Callable[[], str | None],
    wrap_up_authorized_provider: Callable[[], bool],
) -> ChatContext:
    memory_state.refresh_from_transcript(transcript.lines, force=True)
    return build_compact_chat_context(
        source_ctx=session.history,
        base_instructions=base_prompt,
        memory_message=build_interview_memory_message(
            earlier_summary=memory_state.summary_text,
            pending_summary=progress_tracker.pending_summary(),
            runtime_gate_summary=progress_tracker.runtime_gate_summary(),
            anti_repeat_summary=progress_tracker.anti_repeat_summary(),
            wrap_up_authorized=wrap_up_authorized_provider(),
        ),
        runtime_control=runtime_control_provider(),
        max_tail_items=memory_state.max_tail_items,
    )


async def _generate_interview_reply(
    *,
    session: AgentSession,
    base_prompt: str,
    transcript: TranscriptRecorder,
    progress_tracker: InterviewProgressTracker,
    memory_state: InterviewMemoryState,
    runtime_control_provider: Callable[[], str | None],
    wrap_up_authorized_provider: Callable[[], bool],
    instructions: str,
) -> None:
    await session.generate_reply(
        instructions=instructions,
        chat_ctx=_build_scripted_reply_chat_ctx(
            session=session,
            base_prompt=base_prompt,
            transcript=transcript,
            progress_tracker=progress_tracker,
            memory_state=memory_state,
            runtime_control_provider=runtime_control_provider,
            wrap_up_authorized_provider=wrap_up_authorized_provider,
        ),
    )


# ---------------------------------------------------------------------------
# Candidate presence tracking
# ---------------------------------------------------------------------------


class CandidateRoomTracker:
    """Tracks the candidate's join/leave events on a LiveKit room.

    Exposes two ``asyncio.Event`` instances:
      - :attr:`joined` — set the first time the expected candidate appears.
      - :attr:`disconnected` — set when the candidate leaves the room.
    """

    def __init__(self, room: Any, candidate_identity: str) -> None:
        self._room = room
        self._candidate_identity = candidate_identity
        self.joined: asyncio.Event = asyncio.Event()
        self.connected: asyncio.Event = asyncio.Event()
        self.disconnected: asyncio.Event = asyncio.Event()

    def attach(self) -> None:
        self._room.on("participant_connected", self._on_connected)
        self._room.on("participant_disconnected", self._on_disconnected)

        # The candidate may already be present when we attach.
        for rp in list(getattr(self._room, "remote_participants", {}).values()):
            identity = getattr(rp, "identity", "") or ""
            if _is_candidate(identity, self._candidate_identity):
                self.joined.set()
                self.connected.set()
                self.disconnected.clear()
                break

    def detach(self) -> None:
        self._room.off("participant_connected", self._on_connected)
        self._room.off("participant_disconnected", self._on_disconnected)

    def _on_connected(self, participant: Any) -> None:
        identity = getattr(participant, "identity", "") or ""
        if _is_candidate(identity, self._candidate_identity):
            self.joined.set()
            self.connected.set()
            self.disconnected.clear()

    def _on_disconnected(self, participant: Any) -> None:
        identity = getattr(participant, "identity", "") or ""
        if identity.startswith("candidate_"):
            self.connected.clear()
            self.disconnected.set()


# ---------------------------------------------------------------------------
# Persistence helpers
# ---------------------------------------------------------------------------


def _persist_session_started(db: Any, session_id: str) -> None:
    db.interview_sessions.update_one(
        {"session_id": session_id},
        {"$set": {
            "status": "in_progress",
            "candidate_connection_status": "waiting",
            "wrap_up_started_at": None,
            "wrap_up_ends_at": None,
            "wrap_up_reason": None,
            "reconnect_grace_started_at": None,
            "reconnect_grace_ends_at": None,
            "updated_at": now_iso(),
        }},
        upsert=True,
    )


def _persist_first_candidate_join(db: Any, session_id: str) -> None:
    _persist_candidate_connected(db, session_id, first_join=True)


def _persist_evaluation(
    db: Any,
    *,
    session_id: str,
    candidate_id: str,
    interview_id: str,
    eval_doc: dict[str, Any],
) -> None:
    strengths, gaps = _basic_signals_from_stats(eval_doc.get("questionStats") or {})

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
            # New fields from the multi-criterion + skill-weighted evaluation:
            "perSkillScores": eval_doc.get("perSkillScores", {}),
            "skillWeights": eval_doc.get("skillWeights", {}),
            "evaluationFlags": eval_doc.get("evaluationFlags", []),
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
            "completed_at": now_iso(),
            "updated_at": now_iso(),
        }},
    )


# ---------------------------------------------------------------------------
# Main orchestration
# ---------------------------------------------------------------------------


async def _drive_interview(
    *,
    session: AgentSession,
    tracker: CandidateRoomTracker,
    progress_tracker: InterviewProgressTracker,
    runtime_state: dict[str, Any],
    memory_state: InterviewMemoryState,
    runtime_control_provider: Callable[[], str | None],
    wrap_up_authorized_provider: Callable[[], bool],
    base_prompt: str,
    transcript: TranscriptRecorder,
    meta: dict,
    provider_cfg: dict,
    durations: InterviewDurations,
    db: Any,
    session_id: str,
) -> None:
    """Run the active interview phase, including the wrap-up window.

    Returns once the candidate disconnects, the drive timeout fires (and
    the wrap-up completes / times out), or the candidate never joins.
    """
    try:
        await asyncio.wait_for(tracker.joined.wait(), timeout=CANDIDATE_JOIN_TIMEOUT_SECONDS)
    except asyncio.TimeoutError:
        logger.info("[Interview] Candidate did not join in prestart window; ending session workflow.")
        return

    _persist_first_candidate_join(db, session_id)
    wrap_up_started = False
    drive_outcome: str | None = None
    wrap_up_deadline = 0.0
    loop = asyncio.get_running_loop()
    drive_deadline = loop.time() + durations.drive_seconds
    runtime_state["loop"] = loop
    runtime_state["drive_deadline"] = drive_deadline
    runtime_state["wrap_up_started"] = False

    def _on_transcript_line(line: dict) -> None:
        if not bool(line.get("is_final")):
            return
        role = line.get("role")
        text = str(line.get("text") or "")
        if role == "user":
            progress_tracker.note_candidate_response(text)
            return
        if role == "assistant" and not wrap_up_started:
            progress_tracker.note_interviewer_prompt(text)

    transcript.add_listener(_on_transcript_line)
    await _generate_interview_reply(
        session=session,
        base_prompt=base_prompt,
        transcript=transcript,
        progress_tracker=progress_tracker,
        memory_state=memory_state,
        runtime_control_provider=runtime_control_provider,
        wrap_up_authorized_provider=wrap_up_authorized_provider,
        instructions=_initial_reply_instructions(),
    )

    while True:
        if tracker.connected.is_set():
            remaining_drive = max(0.0, drive_deadline - loop.time())
            outcome = await _wait_for_drive_outcome(
                tracker=tracker,
                completion_requested=progress_tracker.completion_requested,
                drive_seconds=remaining_drive,
            )
            if outcome == "candidate_disconnected":
                grace_ends_at = _persist_candidate_disconnected(
                    db,
                    session_id,
                    grace_seconds=RECONNECT_GRACE_SECONDS,
                )
                logger.info(
                    "[Interview] Candidate disconnected; waiting for reconnect grace.",
                    extra={"session_id": session_id, "reconnect_grace_ends_at": grace_ends_at},
                )
                reconnect_outcome = await _wait_for_reconnect(
                    tracker=tracker,
                    timeout_seconds=RECONNECT_GRACE_SECONDS,
                )
                if reconnect_outcome == "candidate_reconnected":
                    _persist_candidate_connected(db, session_id)
                    logger.info("[Interview] Candidate reconnected; resuming interview.")
                    continue
                _persist_session_completed(
                    db,
                    session_id,
                    ended_reason="candidate_disconnect_timeout",
                )
                logger.info("[Interview] Candidate did not reconnect within grace window; ending.")
                return
            if outcome == "completion_requested":
                logger.info(
                    "[Interview] Completion request received; starting verification.",
                    extra={
                        "session_id": session_id,
                        "completion_request_state": progress_tracker.completion_request_debug_state(),
                    },
                )
                progress_tracker.clear_completion_request()
                try:
                    verification = await verify_pre_wrapup_coverage(
                        meta=meta,
                        transcript_lines=transcript.lines,
                        provider_cfg=provider_cfg,
                        coverage_exempt_skills=progress_tracker.verifier_exempt_skill_names(),
                    )
                except Exception:
                    logger.exception("[Interview] Pre-wrap-up verification failed; continuing interview.")
                    if tracker.connected.is_set():
                        await _generate_interview_reply(
                            session=session,
                            base_prompt=base_prompt,
                            transcript=transcript,
                            progress_tracker=progress_tracker,
                            memory_state=memory_state,
                            runtime_control_provider=runtime_control_provider,
                            wrap_up_authorized_provider=wrap_up_authorized_provider,
                            instructions=(
                                "Do not start wrap-up yet. A final verification step could not confirm full coverage. "
                                "Continue the interview and ensure every required interview item is covered, "
                                "then call `mark_interview_plan_completed` again."
                            ),
                        )
                    continue

                progress_tracker.apply_verified_question_marks(verification.verified_question_marks)
                progress_tracker.apply_verified_skill_completions(verification.verified_skill_completions)
                if verification.ready_for_wrapup:
                    authorization = progress_tracker.authorize_plan_completion()
                    if authorization.accepted:
                        drive_outcome = "plan_completed"
                        break
                    blockers = progress_tracker.runtime_gate_blockers()
                    if blockers:
                        logger.info(
                            "[Interview] Skills-only pacing gate blocked early wrap-up.",
                            extra={
                                "session_id": session_id,
                                "runtime_gate_blockers": blockers,
                            },
                        )
                        if tracker.connected.is_set():
                            await _generate_interview_reply(
                                session=session,
                                base_prompt=base_prompt,
                                transcript=transcript,
                                progress_tracker=progress_tracker,
                                memory_state=memory_state,
                                runtime_control_provider=runtime_control_provider,
                                wrap_up_authorized_provider=wrap_up_authorized_provider,
                                instructions=_skills_only_gate_retry_instruction(blockers),
                            )
                        continue

                progress_tracker.plan_completed.clear()
                missing_items = verification.missing_items or progress_tracker.missing_items()
                logger.info(
                    "[Interview] Pre-wrap-up verification found missing required items.",
                    extra={
                        "session_id": session_id,
                        "missing_items": missing_items,
                        "notes": verification.notes,
                    },
                )
                if tracker.connected.is_set():
                    await _generate_interview_reply(
                        session=session,
                        base_prompt=base_prompt,
                        transcript=transcript,
                        progress_tracker=progress_tracker,
                        memory_state=memory_state,
                        runtime_control_provider=runtime_control_provider,
                        wrap_up_authorized_provider=wrap_up_authorized_provider,
                        instructions=_missing_items_retry_instruction(
                            missing_items,
                            verification.notes,
                        ),
                    )
                continue
            drive_outcome = outcome
            break

        _persist_candidate_disconnected(db, session_id, grace_seconds=RECONNECT_GRACE_SECONDS)
        reconnect_outcome = await _wait_for_reconnect(
            tracker=tracker,
            timeout_seconds=RECONNECT_GRACE_SECONDS,
        )
        if reconnect_outcome == "candidate_reconnected":
            _persist_candidate_connected(db, session_id)
            continue
        _persist_session_completed(
            db,
            session_id,
            ended_reason="candidate_disconnect_timeout",
        )
        logger.info("[Interview] Candidate remained disconnected; ending before wrap-up.")
        return

    if drive_outcome in ("timeout", "plan_completed"):
        reason = "plan_completed" if drive_outcome == "plan_completed" else "duration_elapsed"
        wrap_up_deadline = loop.time() + durations.conclude_buffer_seconds
        wrap_up_started = True
        runtime_state["wrap_up_started"] = True
        wrap_up_ends_at = _persist_wrap_up_started(
            db,
            session_id,
            wrap_up_seconds=durations.conclude_buffer_seconds,
            reason=reason,
        )
        if drive_outcome == "plan_completed":
            logger.info(
                "[Interview] Interview plan completed early; starting wrap-up.",
                extra={"session_id": session_id, "wrap_up_ends_at": wrap_up_ends_at},
            )
        else:
            logger.info(
                "[Interview] Interview duration elapsed; runtime is authorizing wrap-up.",
                extra={"session_id": session_id, "wrap_up_ends_at": wrap_up_ends_at},
            )
        if tracker.connected.is_set():
            await _generate_interview_reply(
                session=session,
                base_prompt=base_prompt,
                transcript=transcript,
                progress_tracker=progress_tracker,
                memory_state=memory_state,
                runtime_control_provider=runtime_control_provider,
                wrap_up_authorized_provider=wrap_up_authorized_provider,
                instructions=_wrap_up_instruction_text(durations.conclude_buffer_seconds),
            )

    if not wrap_up_started:
        _persist_session_completed(
            db,
            session_id,
            ended_reason="candidate_disconnected",
        )
        return

    while True:
        remaining_wrap_up = max(0.0, wrap_up_deadline - loop.time())
        if remaining_wrap_up <= 0:
            _persist_session_completed(
                db,
                session_id,
                ended_reason="wrap_up_complete",
            )
            logger.info("[Interview] Wrap-up window ended; marking session completed.")
            return

        if tracker.connected.is_set():
            try:
                await asyncio.wait_for(tracker.disconnected.wait(), timeout=remaining_wrap_up)
            except asyncio.TimeoutError:
                _persist_session_completed(
                    db,
                    session_id,
                    ended_reason="wrap_up_complete",
                )
                logger.info("[Interview] Wrap-up timeout reached; ending session workflow.")
                return

            _persist_candidate_disconnected(
                db,
                session_id,
                grace_seconds=min(RECONNECT_GRACE_SECONDS, max(1, int(remaining_wrap_up))),
            )
            reconnect_outcome = await _wait_for_reconnect(
                tracker=tracker,
                timeout_seconds=min(RECONNECT_GRACE_SECONDS, remaining_wrap_up),
            )
            if reconnect_outcome == "candidate_reconnected":
                _persist_candidate_connected(db, session_id)
                continue
            _persist_session_completed(
                db,
                session_id,
                ended_reason="wrap_up_disconnect_timeout",
            )
            logger.info("[Interview] Candidate did not reconnect before wrap-up ended.")
            return

        reconnect_outcome = await _wait_for_reconnect(
            tracker=tracker,
            timeout_seconds=min(RECONNECT_GRACE_SECONDS, remaining_wrap_up),
        )
        if reconnect_outcome == "candidate_reconnected":
            _persist_candidate_connected(db, session_id)
            continue
        _persist_session_completed(
            db,
            session_id,
            ended_reason="wrap_up_disconnect_timeout",
        )
        logger.info("[Interview] Wrap-up ended while candidate was disconnected.")
        return


async def run_interview(
    ctx: JobContext,
    meta: dict,
    *,
    settings: Settings | None = None,
) -> None:
    """Run a single interview from connect → evaluation persistence."""
    if meta.get("mode") != EXPECTED_MODE:
        raise ValueError(f"Expected mode={EXPECTED_MODE} in dispatch metadata")

    cfg = settings or default_settings
    db = get_db()

    session_id = meta.get("sessionId") or str(uuid4())
    interview_id = meta.get("interviewId", "")
    candidate_id = meta.get("candidateId", "")
    interview_meta = meta.get("interviewMeta") or {}
    durations = compute_durations(interview_meta)
    progress_tracker = InterviewProgressTracker(interview_meta)

    prompt = build_prompt(meta, plan=progress_tracker.plan)
    provider_cfg = resolve_provider_cfg(meta, cfg)

    logger.info(
        "[Interview] Runtime providers: llm=%s, stt=%s, tts=%s model=%s voice=%s key_present=%s",
        provider_cfg["llm"]["provider"],
        provider_cfg["stt"]["provider"],
        provider_cfg["tts"]["provider"],
        provider_cfg["tts"]["model"],
        provider_cfg["tts"]["voice"],
        bool(provider_cfg["tts"]["api_key"]),
    )

    llm = get_llm(
        provider_cfg["llm"]["provider"],
        provider_cfg["llm"]["api_key"],
        provider_cfg["llm"]["model"],
    )
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

    transcript = TranscriptRecorder(db, session_id)

    await ctx.connect()
    memory_state = InterviewMemoryState()
    session = AgentSession(userdata=memory_state)
    runtime_state: dict[str, Any] = {
        "loop": None,
        "drive_deadline": None,
        "wrap_up_started": False,
    }
    def _wrap_up_authorized_provider() -> bool:
        return bool(runtime_state.get("wrap_up_started"))

    def _runtime_control_provider() -> str | None:
        if progress_tracker.plan_mode == "none":
            return None
        if runtime_state.get("wrap_up_started"):
            return build_runtime_control_message(
                plan_mode=progress_tracker.plan_mode,
                wrap_up_authorized=True,
            )
        loop = runtime_state.get("loop")
        drive_deadline = runtime_state.get("drive_deadline")
        if loop is not None and drive_deadline is not None:
            remaining_minutes = max(0.0, drive_deadline - loop.time()) / 60.0
        else:
            remaining_minutes = max(0.0, durations.drive_seconds) / 60.0
        return build_runtime_control_message(
            plan_mode=progress_tracker.plan_mode,
            remaining_minutes=remaining_minutes,
            wrap_up_authorized=False,
        )

    if progress_tracker.plan_mode == "prepared_questions":
        agent = PreparedQuestionsInterviewAgent(
            instructions=prompt,
            stt=stt,
            llm=llm,
            tts=tts,
            progress_tracker=progress_tracker,
            transcript=transcript,
            memory_state=memory_state,
            runtime_control_provider=_runtime_control_provider,
            wrap_up_authorized_provider=_wrap_up_authorized_provider,
        )
    elif progress_tracker.plan_mode == "skills_only":
        agent = SkillsOnlyInterviewAgent(
            instructions=prompt,
            stt=stt,
            llm=llm,
            tts=tts,
            progress_tracker=progress_tracker,
            transcript=transcript,
            memory_state=memory_state,
            runtime_control_provider=_runtime_control_provider,
            wrap_up_authorized_provider=_wrap_up_authorized_provider,
        )
    else:
        agent = Agent(instructions=prompt, stt=stt, llm=llm, tts=tts)
    transcript.attach(session)

    room_options = room_io.RoomOptions(video_input=True)
    if candidate_id:
        room_options.participant_identity = _candidate_identity(candidate_id)

    avatar_started = await maybe_attach_avatar(
        session=session, ctx=ctx, room_options=room_options, avatar=cfg.avatar
    )
    await session.start(room=ctx.room, agent=agent, room_options=room_options)
    if avatar_started:
        logger.info("[Avatar] Simli avatar worker started for interview session")

    _persist_session_started(db, session_id)

    tracker = CandidateRoomTracker(ctx.room, _candidate_identity(candidate_id))
    tracker.attach()
    try:
        await _drive_interview(
            session=session,
            tracker=tracker,
            progress_tracker=progress_tracker,
            runtime_state=runtime_state,
            memory_state=memory_state,
            runtime_control_provider=_runtime_control_provider,
            wrap_up_authorized_provider=_wrap_up_authorized_provider,
            base_prompt=prompt,
            transcript=transcript,
            meta=meta,
            provider_cfg=provider_cfg,
            durations=durations,
            db=db,
            session_id=session_id,
        )
    finally:
        tracker.detach()

    eval_doc = await generate_structured_evaluation(
        transcript_lines=transcript.lines,
        meta=meta,
        provider_cfg=provider_cfg,
    )
    _persist_evaluation(
        db,
        session_id=session_id,
        candidate_id=candidate_id,
        interview_id=interview_id,
        eval_doc=eval_doc,
    )


async def entrypoint(ctx: JobContext) -> None:
    """LiveKit worker entrypoint — parses metadata and delegates to :func:`run_interview`."""
    metadata = parse_metadata(getattr(ctx.job, "metadata", None))
    await run_interview(ctx, metadata)


__all__ = ["run_interview", "entrypoint"]

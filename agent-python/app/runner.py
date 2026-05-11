"""End-to-end interview session orchestration + worker entrypoint.

This module deliberately stays as the only place where the various app
sub-modules are stitched together; everything else is a small helper or
data class with a single responsibility.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any
from uuid import uuid4

from livekit.agents import AgentSession, JobContext, room_io
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
from .interview_progress import InterviewProgressTracker
from .metadata import InterviewDurations, compute_durations, parse_metadata
from .prompt import build_prompt
from .provider_resolver import resolve_provider_cfg
from .time_utils import now_iso
from .transcript import TranscriptRecorder

logger = logging.getLogger(__name__)

EXPECTED_MODE = "video_interview"
CANDIDATE_JOIN_TIMEOUT_SECONDS = 10 * 60

WRAP_UP_INSTRUCTIONS = (
    "Begin interview wrap-up now. Ask one concise final check question only if essential, "
    "then ask whether the candidate has any final questions. Respond briefly and conclude "
    "politely now so the interview ends within the allotted time."
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _initial_reply_instructions(has_prepared: bool) -> str:
    """Kickoff turn: greet + readiness check only. Do NOT ask the first question yet."""
    del has_prepared  # first question waits for the candidate's readiness reply
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


class InterviewAgent(Agent):
    """Interview agent with structured progress-reporting tools."""

    def __init__(
        self,
        *,
        instructions: str,
        stt: Any,
        llm: Any,
        tts: Any,
        progress_tracker: InterviewProgressTracker,
    ) -> None:
        super().__init__(instructions=instructions, stt=stt, llm=llm, tts=tts)
        self._progress_tracker = progress_tracker

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

    @function_tool(flags=ToolFlag.IGNORE_ON_ENTER)
    async def mark_interview_plan_completed(self, context: RunContext) -> str:
        """Validate whether all required interview items are complete and wrap-up should begin now."""
        del context
        update = self._progress_tracker.confirm_plan_completed()
        if not update.accepted:
            raise ToolError(update.message)
        return update.message


async def _wait_for_drive_outcome(
    *,
    tracker: "CandidateRoomTracker",
    plan_completed: asyncio.Event,
    drive_seconds: int,
) -> str:
    """Wait for the first interview-ending condition.

    Returns one of: ``candidate_disconnected``, ``plan_completed``, ``timeout``.
    """
    disconnect_task = asyncio.create_task(tracker.disconnected.wait())
    plan_completed_task = asyncio.create_task(plan_completed.wait())
    timeout_task = asyncio.create_task(asyncio.sleep(drive_seconds))

    try:
        done, pending = await asyncio.wait(
            {disconnect_task, plan_completed_task, timeout_task},
            return_when=asyncio.FIRST_COMPLETED,
        )
    finally:
        for task in (disconnect_task, plan_completed_task, timeout_task):
            if task.done():
                continue
            task.cancel()
        await asyncio.gather(
            disconnect_task,
            plan_completed_task,
            timeout_task,
            return_exceptions=True,
        )

    if tracker.disconnected.is_set():
        return "candidate_disconnected"
    if plan_completed.is_set() and plan_completed_task in done:
        return "plan_completed"
    return "timeout"


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
        self.disconnected: asyncio.Event = asyncio.Event()

    def attach(self) -> None:
        self._room.on("participant_connected", self._on_connected)
        self._room.on("participant_disconnected", self._on_disconnected)

        # The candidate may already be present when we attach.
        for rp in list(getattr(self._room, "remote_participants", {}).values()):
            identity = getattr(rp, "identity", "") or ""
            if _is_candidate(identity, self._candidate_identity):
                self.joined.set()
                break

    def detach(self) -> None:
        self._room.off("participant_connected", self._on_connected)
        self._room.off("participant_disconnected", self._on_disconnected)

    def _on_connected(self, participant: Any) -> None:
        identity = getattr(participant, "identity", "") or ""
        if _is_candidate(identity, self._candidate_identity):
            self.joined.set()

    def _on_disconnected(self, participant: Any) -> None:
        identity = getattr(participant, "identity", "") or ""
        if identity.startswith("candidate_"):
            self.disconnected.set()


# ---------------------------------------------------------------------------
# Persistence helpers
# ---------------------------------------------------------------------------


def _persist_session_started(db: Any, session_id: str) -> None:
    db.interview_sessions.update_one(
        {"session_id": session_id},
        {"$set": {"status": "in_progress", "updated_at": now_iso()}},
        upsert=True,
    )


def _persist_first_candidate_join(db: Any, session_id: str) -> None:
    db.interview_sessions.update_one(
        {"session_id": session_id, "started_at": {"$exists": False}},
        {"$set": {"started_at": now_iso(), "updated_at": now_iso()}},
    )


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
        {"$set": {"status": "completed", "updated_at": now_iso()}},
    )


# ---------------------------------------------------------------------------
# Main orchestration
# ---------------------------------------------------------------------------


async def _drive_interview(
    *,
    session: AgentSession,
    tracker: CandidateRoomTracker,
    plan_completed: asyncio.Event,
    durations: InterviewDurations,
    has_prepared: bool,
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

    await session.generate_reply(instructions=_initial_reply_instructions(has_prepared))

    outcome = await _wait_for_drive_outcome(
        tracker=tracker,
        plan_completed=plan_completed,
        drive_seconds=durations.drive_seconds,
    )
    if outcome in ("timeout", "plan_completed"):
        if outcome == "plan_completed":
            logger.info("[Interview] Interview plan completed early; starting wrap-up.")
        await session.generate_reply(instructions=WRAP_UP_INSTRUCTIONS)
        try:
            await asyncio.wait_for(
                tracker.disconnected.wait(), timeout=durations.conclude_buffer_seconds
            )
        except asyncio.TimeoutError:
            logger.info("[Interview] Wrap-up timeout reached; ending session workflow.")


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
    has_prepared = bool(interview_meta.get("questions"))
    progress_tracker = InterviewProgressTracker(interview_meta)

    prompt = build_prompt(meta)
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
    session = AgentSession()
    if progress_tracker.has_plan:
        agent = InterviewAgent(
            instructions=prompt,
            stt=stt,
            llm=llm,
            tts=tts,
            progress_tracker=progress_tracker,
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
            plan_completed=progress_tracker.plan_completed,
            durations=durations,
            has_prepared=has_prepared,
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

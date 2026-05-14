import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from livekit.agents import ChatContext

from app.interview_memory import InterviewMemoryState
from app.interview_plan import resolve_interview_plan
from app.provider_resolver import resolve_provider_cfg
from app.interview_progress import InterviewProgressTracker
from app.pre_wrapup_verifier import _build_verification_user_prompt, verify_pre_wrapup_coverage
from app.prompt import build_interview_memory_message, compose_runtime_instructions
from app.runner import (
    CandidateRoomTracker,
    _build_scripted_reply_chat_ctx,
    _generate_interview_reply,
    _resume_after_reconnect_instructions,
    _wait_for_drive_outcome,
    _wait_for_reconnect,
)
from app.skills import canonical_skill_key


class InterviewProgressTrackerTests(unittest.TestCase):
    def test_prepared_questions_only_need_explicit_authorization(self) -> None:
        tracker = InterviewProgressTracker({
            "questions": [{
                "skill": "Core Java",
                "questions": ["Q1", "Q2"],
                "askFollowUps": True,
                "allowAdditional": False,
                "weightage": 100,
            }],
        })

        self.assertTrue(tracker.has_plan)
        self.assertFalse(tracker.plan_completed.is_set())
        self.assertFalse(tracker.completion_requested.is_set())

        first = tracker.mark_question_asked("Core Java", 1)
        self.assertTrue(first.accepted)
        self.assertFalse(first.plan_completed)
        self.assertIn("2", first.message)

        second = tracker.mark_question_asked("Core Java", 2)
        self.assertTrue(second.accepted)
        self.assertFalse(second.plan_completed)
        self.assertFalse(tracker.plan_completed.is_set())
        self.assertTrue(tracker.is_structurally_complete())

        confirm = tracker.confirm_plan_completed()
        self.assertTrue(confirm.accepted)
        self.assertFalse(confirm.plan_completed)
        self.assertTrue(tracker.completion_requested.is_set())

        authorize = tracker.authorize_plan_completion()
        self.assertTrue(authorize.accepted)
        self.assertTrue(tracker.plan_completed.is_set())
        self.assertFalse(tracker.completion_requested.is_set())

    def test_skills_only_gate_blocks_early_skill_completion(self) -> None:
        tracker = InterviewProgressTracker({
            "durationMinutes": 20,
            "skills": [
                {"skill": "React", "weightage": 100, "difficulty": "easy"},
            ],
        })

        self.assertEqual(tracker.pending_summary(), "React coverage")
        with patch("app.interview_progress.time.monotonic", return_value=0.0):
            tracker.note_candidate_response("Yes, I am ready.")
            first = tracker.mark_skill_completed("React")
        self.assertFalse(first.accepted)
        self.assertFalse(first.plan_completed)
        self.assertIn("Runtime control: completion denied", first.message)
        self.assertIn("Do not mention wrap-up", first.message)
        self.assertIn("15.0 more minutes remain", first.message)
        with patch("app.interview_progress.time.monotonic", return_value=0.0):
            self.assertEqual(
                tracker.runtime_gate_summary(),
                "React needs about 15.0 more min or 4 consecutive non-responses (current streak: 0)",
            )

    def test_skills_only_gate_releases_after_time_budget(self) -> None:
        tracker = InterviewProgressTracker({
            "durationMinutes": 20,
            "skills": [
                {"skill": "React", "weightage": 100, "difficulty": "easy"},
            ],
        })
        with patch("app.interview_progress.time.monotonic", return_value=0.0):
            tracker.note_candidate_response("Ready")
        with patch("app.interview_progress.time.monotonic", return_value=900.0):
            second = tracker.mark_skill_completed("React")
        self.assertTrue(second.accepted)
        self.assertFalse(second.plan_completed)
        self.assertTrue(tracker.is_structurally_complete())

    def test_skills_only_gate_releases_after_four_nonresponses(self) -> None:
        tracker = InterviewProgressTracker({
            "durationMinutes": 20,
            "skills": [
                {"skill": "React", "weightage": 100, "difficulty": "easy"},
            ],
        })
        with patch("app.interview_progress.time.monotonic", return_value=0.0):
            tracker.note_candidate_response("Ready")
        with patch("app.interview_progress.time.monotonic", return_value=60.0):
            tracker.note_candidate_response("I don't know")
            tracker.note_candidate_response("Not sure")
            tracker.note_candidate_response("No idea")
            tracker.note_candidate_response("Skip this")
            update = tracker.mark_skill_completed("React")
        self.assertTrue(update.accepted)
        self.assertTrue(tracker.is_structurally_complete())

    def test_single_skill_nonresponse_auto_requests_runtime_wrapup(self) -> None:
        tracker = InterviewProgressTracker({
            "durationMinutes": 20,
            "skills": [
                {"skill": "React.js", "weightage": 100, "difficulty": "easy"},
            ],
        })
        with patch("app.interview_progress.time.monotonic", return_value=0.0):
            tracker.note_candidate_response("Ready")
        with patch("app.interview_progress.time.monotonic", return_value=60.0):
            tracker.note_candidate_response("I don't know")
            tracker.note_candidate_response("I don't know")
            tracker.note_candidate_response("I don't know")
            tracker.note_candidate_response("I don't know")
        self.assertTrue(tracker.completion_requested.is_set())
        self.assertTrue(tracker.is_structurally_complete())
        with patch("app.interview_progress.time.monotonic", return_value=60.0):
            self.assertEqual(tracker.verifier_exempt_skill_names(), ["React.js"])

    def test_single_skill_nonresponse_threshold_reverses_after_real_answer(self) -> None:
        tracker = InterviewProgressTracker({
            "durationMinutes": 20,
            "skills": [
                {"skill": "React.js", "weightage": 100, "difficulty": "easy"},
            ],
        })
        with patch("app.interview_progress.time.monotonic", return_value=0.0):
            tracker.note_candidate_response("Ready")
        with patch("app.interview_progress.time.monotonic", return_value=60.0):
            tracker.note_candidate_response("I don't know")
            tracker.note_candidate_response("I don't know")
            tracker.note_candidate_response("I don't know")
            tracker.note_candidate_response("I don't know")
        self.assertTrue(tracker.completion_requested.is_set())
        self.assertTrue(tracker.is_structurally_complete())

        with patch("app.interview_progress.time.monotonic", return_value=90.0):
            tracker.note_candidate_response("React uses reusable components and props.")

        self.assertFalse(tracker.completion_requested.is_set())
        self.assertFalse(tracker.is_structurally_complete())
        self.assertEqual(tracker.verifier_exempt_skill_names(), [])
        with patch("app.interview_progress.time.monotonic", return_value=90.0):
            self.assertEqual(
                tracker.runtime_gate_summary(),
                "React.js needs about 13.5 more min or 4 consecutive non-responses (current streak: 0)",
            )

    def test_mixed_plan_is_rejected_at_boundary(self) -> None:
        with self.assertRaises(ValueError):
            InterviewProgressTracker({
                "questions": [{
                    "skill": "Core Java",
                    "questions": ["Q1", "Q2"],
                }],
                "skills": [{"skill": "SQL"}],
            })

    def test_verified_corrections_can_release_wrapup(self) -> None:
        tracker = InterviewProgressTracker({
            "questions": [{
                "skill": "Core Java",
                "questions": ["Q1", "Q2"],
            }],
        })

        tracker.apply_verified_question_marks([("Core Java", 1), ("Core Java", 2)])
        self.assertTrue(tracker.is_structurally_complete())

        tracker.confirm_plan_completed()
        authorize = tracker.authorize_plan_completion()
        self.assertTrue(authorize.accepted)
        self.assertTrue(tracker.plan_completed.is_set())

    def test_skills_only_authorization_blocks_verified_completion_until_time_gate(self) -> None:
        tracker = InterviewProgressTracker({
            "durationMinutes": 20,
            "skills": [{"skill": "React"}],
        })
        tracker.apply_verified_skill_completions(["React"])
        self.assertTrue(tracker.is_structurally_complete())

        confirm = tracker.confirm_plan_completed()
        self.assertTrue(confirm.accepted)
        authorize = tracker.authorize_plan_completion()
        self.assertFalse(authorize.accepted)
        self.assertIn("skills-only pacing gate", authorize.message)

    def test_skill_aliases_match_for_progress_tracking(self) -> None:
        tracker = InterviewProgressTracker({
            "durationMinutes": 20,
            "skills": [{"skill": "React.js", "weightage": 100}],
        })
        with patch("app.interview_progress.time.monotonic", return_value=0.0):
            tracker.note_candidate_response("Ready")
        with patch("app.interview_progress.time.monotonic", return_value=900.0):
            update = tracker.mark_skill_completed("React")
        self.assertTrue(update.accepted)
        self.assertTrue(tracker.is_structurally_complete())

    def test_single_skill_nonresponse_exposes_verifier_exemption(self) -> None:
        tracker = InterviewProgressTracker({
            "durationMinutes": 20,
            "skills": [{"skill": "React.js", "weightage": 100}],
        })
        with patch("app.interview_progress.time.monotonic", return_value=0.0):
            tracker.note_candidate_response("Ready")
        with patch("app.interview_progress.time.monotonic", return_value=60.0):
            tracker.note_candidate_response("I don't know")
            tracker.note_candidate_response("I don't know")
            tracker.note_candidate_response("I don't know")
            tracker.note_candidate_response("I don't know")
        self.assertTrue(tracker.completion_requested.is_set())
        with patch("app.interview_progress.time.monotonic", return_value=60.0):
            self.assertEqual(tracker.verifier_exempt_skill_names(), ["React.js"])

    def test_skills_only_tracks_already_asked_question_angles(self) -> None:
        tracker = InterviewProgressTracker({
            "durationMinutes": 20,
            "skills": [{"skill": "React", "weightage": 100}],
        })

        tracker.note_interviewer_prompt("Are you ready to begin?")
        self.assertEqual(tracker.anti_repeat_summary(), "none")

        with patch("app.interview_progress.time.monotonic", return_value=0.0):
            tracker.note_candidate_response("Ready")

        tracker.note_interviewer_prompt("Can you explain state vs props in React?")
        tracker.note_interviewer_prompt("Please explain state vs props in React?")
        tracker.note_interviewer_prompt("How do React hooks help with component state?")

        summary = tracker.anti_repeat_summary()
        self.assertIn("Already asked on React:", summary)
        self.assertIn("state vs props in react", summary)
        self.assertIn("react hooks help with component state", summary)
        self.assertEqual(summary.count("state vs props in react"), 1)

    def test_mark_skill_completed_rejects_prepared_question_skill(self) -> None:
        tracker = InterviewProgressTracker({
            "questions": [{
                "skill": "Core Java",
                "questions": ["Q1"],
            }],
        })

        update = tracker.mark_skill_completed("Core Java")
        self.assertFalse(update.accepted)
        self.assertIn("mark_question_asked", update.message)


class _FakeTracker:
    def __init__(self) -> None:
        self.connected = asyncio.Event()
        self.disconnected = asyncio.Event()


class _FakeRoom:
    def __init__(self) -> None:
        self.handlers = {}
        self.remote_participants = {}

    def on(self, event, handler) -> None:
        self.handlers[event] = handler

    def off(self, event, handler) -> None:
        if self.handlers.get(event) is handler:
            del self.handlers[event]


class _FakeParticipant:
    def __init__(self, identity: str) -> None:
        self.identity = identity


class WaitForDriveOutcomeTests(unittest.IsolatedAsyncioTestCase):
    async def test_completion_request_wins_before_timeout(self) -> None:
        tracker = _FakeTracker()
        tracker.connected.set()
        completion_requested = asyncio.Event()

        async def trigger() -> None:
            await asyncio.sleep(0.01)
            completion_requested.set()

        asyncio.create_task(trigger())
        outcome = await _wait_for_drive_outcome(
            tracker=tracker,
            completion_requested=completion_requested,
            drive_seconds=1,
        )
        self.assertEqual(outcome, "completion_requested")

    async def test_disconnect_wins_before_completion(self) -> None:
        tracker = _FakeTracker()
        tracker.connected.set()
        completion_requested = asyncio.Event()

        async def trigger() -> None:
            await asyncio.sleep(0.01)
            tracker.disconnected.set()

        asyncio.create_task(trigger())
        outcome = await _wait_for_drive_outcome(
            tracker=tracker,
            completion_requested=completion_requested,
            drive_seconds=1,
        )
        self.assertEqual(outcome, "candidate_disconnected")

    async def test_timeout_still_falls_back_when_no_completion_signal(self) -> None:
        tracker = _FakeTracker()
        tracker.connected.set()
        completion_requested = asyncio.Event()

        outcome = await _wait_for_drive_outcome(
            tracker=tracker,
            completion_requested=completion_requested,
            drive_seconds=0,
        )
        self.assertEqual(outcome, "timeout")

    async def test_reconnect_wait_accepts_recovery_before_timeout(self) -> None:
        tracker = _FakeTracker()

        async def trigger() -> None:
            await asyncio.sleep(0.01)
            tracker.connected.set()

        asyncio.create_task(trigger())
        outcome = await _wait_for_reconnect(
            tracker=tracker,
            timeout_seconds=1,
        )
        self.assertEqual(outcome, "candidate_reconnected")


class InterviewPlanHelpersTests(unittest.TestCase):
    def test_resolve_interview_plan_picks_prepared_flow(self) -> None:
        plan = resolve_interview_plan({
            "questions": [{"skill": "React", "questions": ["Q1"]}],
        })
        self.assertEqual(plan.mode, "prepared_questions")
        self.assertEqual(len(plan.question_groups), 1)
        self.assertEqual(plan.skill_specs, [])

    def test_compose_runtime_instructions_adds_remaining_time_before_wrapup(self) -> None:
        instructions = compose_runtime_instructions(
            "Base prompt",
            plan_mode="prepared_questions",
            remaining_minutes=12.5,
        )
        self.assertIn("Remaining interview time before runtime wrap-up authorization: 12.5 min.", instructions)
        self.assertIn("Do not say the remaining time aloud", instructions)
        self.assertNotIn("Wrap-up is explicitly authorized", instructions)

    def test_compose_runtime_instructions_switches_to_wrapup_mode(self) -> None:
        instructions = compose_runtime_instructions(
            "Base prompt",
            plan_mode="skills_only",
            wrap_up_authorized=True,
        )
        self.assertIn("Wrap-up is explicitly authorized by runtime.", instructions)
        self.assertNotIn("Remaining interview time before runtime wrap-up authorization", instructions)

    def test_resume_after_reconnect_instruction_differs_for_wrapup(self) -> None:
        live = _resume_after_reconnect_instructions()
        wrap = _resume_after_reconnect_instructions(wrap_up_active=True)
        self.assertIn("resuming from the current topic or skill", live)
        self.assertIn("final wrap-up is continuing now", wrap)


class CandidateReconnectTrackerTests(unittest.TestCase):
    def test_disconnect_only_tracks_expected_candidate_identity(self) -> None:
        room = _FakeRoom()
        tracker = CandidateRoomTracker(room, "candidate_123")
        tracker.attach()

        tracker._on_connected(_FakeParticipant("candidate_123"))
        self.assertTrue(tracker.connected.is_set())
        self.assertFalse(tracker.disconnected.is_set())

        tracker._on_disconnected(_FakeParticipant("candidate_other"))
        self.assertTrue(tracker.connected.is_set())
        self.assertFalse(tracker.disconnected.is_set())

        tracker._on_disconnected(_FakeParticipant("candidate_123"))
        self.assertFalse(tracker.connected.is_set())
        self.assertTrue(tracker.disconnected.is_set())


class PreWrapupVerifierTests(unittest.IsolatedAsyncioTestCase):
    async def test_verifier_short_circuits_when_no_structured_plan(self) -> None:
        result = await verify_pre_wrapup_coverage(
            meta={"interviewMeta": {}},
            transcript_lines=[],
            provider_cfg={},
        )
        self.assertTrue(result.ready_for_wrapup)
        self.assertEqual(result.missing_items, [])

    def test_verification_prompt_uses_assistant_transcript_only(self) -> None:
        prompt = _build_verification_user_prompt(
            {
                "interviewMeta": {
                    "questions": [{
                        "skill": "React",
                        "questions": ["What are React Hooks?"],
                    }],
                }
            },
            [
                {"role": "assistant", "text": "What are React Hooks?", "is_final": True},
                {"role": "user", "text": "I don't know.", "is_final": True},
            ],
        )
        self.assertIn("Interviewer transcript only:", prompt)
        self.assertIn("Interviewer: What are React Hooks?", prompt)
        self.assertNotIn("Candidate: I don't know.", prompt)

    async def test_verifier_normalizes_missing_and_verified_items(self) -> None:
        meta = {
            "interviewMeta": {
                "questions": [{
                    "skill": "Core Java",
                    "questions": ["Q1", "Q2"],
                }],
            }
        }
        transcript_lines = [
            {"role": "assistant", "text": "Q1", "is_final": True},
            {"role": "user", "text": "Answer", "is_final": True},
        ]
        provider_cfg = {"llm": {"provider": "openai", "api_key": "k", "model": "m"}}
        mocked = {
            "verifiedPreparedQuestions": [{"skill": "Core Java", "questionNumbers": [1]}],
            "missingQuestions": [{"skill": "Core Java", "questionNumber": 2, "question": "Q2"}],
            "readyForWrapup": False,
            "notes": "Question 2 was not clearly covered.",
        }
        with patch("app.pre_wrapup_verifier._eval_json", new=AsyncMock(return_value=mocked)):
            result = await verify_pre_wrapup_coverage(
                meta=meta,
                transcript_lines=transcript_lines,
                provider_cfg=provider_cfg,
            )

        self.assertFalse(result.ready_for_wrapup)
        self.assertEqual(result.verified_question_marks, [("Core Java", 1)])
        self.assertEqual(len(result.missing_items), 1)
        self.assertEqual(result.missing_items[0]["type"], "question")
        self.assertIn("Question 2", result.notes)

    async def test_verifier_normalizes_skill_aliases_to_plan_name(self) -> None:
        meta = {
            "interviewMeta": {
                "skills": [{"skill": "React.js"}],
            }
        }
        provider_cfg = {"llm": {"provider": "openai", "api_key": "k", "model": "m"}}
        mocked = {
            "verifiedPreparedQuestions": [],
            "verifiedSkills": ["React"],
            "missingQuestions": [],
            "missingSkills": [],
            "readyForWrapup": True,
            "notes": "Candidate covered React fundamentals. One weak topic does not make the whole skill missing.",
        }
        with patch("app.pre_wrapup_verifier._eval_json", new=AsyncMock(return_value=mocked)):
            result = await verify_pre_wrapup_coverage(
                meta=meta,
                transcript_lines=[{"role": "assistant", "text": "Explain React hooks.", "is_final": True}],
                provider_cfg=provider_cfg,
            )

        self.assertTrue(result.ready_for_wrapup)
        self.assertEqual(result.verified_skill_completions, ["React.js"])
        self.assertEqual(result.missing_items, [])

    async def test_verifier_skips_substantive_skill_missing_for_single_skill_nonresponse_exemption(self) -> None:
        meta = {
            "interviewMeta": {
                "skills": [{"skill": "React.js"}],
            }
        }
        provider_cfg = {"llm": {"provider": "openai", "api_key": "k", "model": "m"}}
        mocked = {
            "verifiedPreparedQuestions": [],
            "verifiedSkills": [],
            "missingQuestions": [],
            "missingSkills": ["React"],
            "readyForWrapup": False,
            "notes": "Candidate repeatedly said they did not know the answers.",
        }
        with patch("app.pre_wrapup_verifier._eval_json", new=AsyncMock(return_value=mocked)):
            result = await verify_pre_wrapup_coverage(
                meta=meta,
                transcript_lines=[{"role": "user", "text": "I don't know.", "is_final": True}],
                provider_cfg=provider_cfg,
                coverage_exempt_skills=["React.js"],
            )

        self.assertTrue(result.ready_for_wrapup)
        self.assertEqual(result.verified_skill_completions, ["React.js"])
        self.assertEqual(result.missing_items, [])


class ProviderResolverTests(unittest.TestCase):
    def test_xai_llm_alias_uses_xai_api_key(self) -> None:
        meta = {
            "providerConfig": {
                "llm": {
                    "provider": "xai",
                    "model": "grok-4-1-fast-non-reasoning",
                }
            }
        }
        with patch.dict("os.environ", {"XAI_API_KEY": "x-test-key"}, clear=False):
            cfg = resolve_provider_cfg(meta)

        self.assertEqual(cfg["llm"]["provider"], "xai")
        self.assertEqual(cfg["llm"]["model"], "grok-4-1-fast-non-reasoning")
        self.assertEqual(cfg["llm"]["api_key"], "x-test-key")


class LongConversationContextTests(unittest.IsolatedAsyncioTestCase):
    def test_interview_memory_refresh_only_summarizes_older_lines(self) -> None:
        memory_state = InterviewMemoryState(summary_tail_lines=2)
        transcript_lines = [
            {"role": "assistant", "text": "Explain React state.", "is_final": True},
            {"role": "user", "text": "State stores component data.", "is_final": True},
            {"role": "assistant", "text": "How do hooks work?", "is_final": True},
            {"role": "user", "text": "Hooks let function components use state.", "is_final": True},
        ]

        summary = memory_state.refresh_from_transcript(transcript_lines, force=True)

        self.assertIn("Explain React state.", summary)
        self.assertIn("State stores component data.", summary)
        self.assertNotIn("How do hooks work?", summary)
        self.assertNotIn("Hooks let function components use state.", summary)

    def test_build_scripted_reply_chat_ctx_uses_bounded_tail(self) -> None:
        tracker = InterviewProgressTracker({
            "questions": [{"skill": "React", "questions": ["Q1", "Q2"]}],
        })
        history = ChatContext()
        history.add_message(role="system", content="old instructions")
        for idx in range(6):
            history.add_message(role="assistant", content=f"assistant-{idx}")
            history.add_message(role="user", content=f"user-{idx}")

        session = type("Session", (), {"history": history})()
        transcript = type("Transcript", (), {
            "lines": [
                {"role": "assistant", "text": "Explain React state.", "is_final": True},
                {"role": "user", "text": "State stores component data.", "is_final": True},
                {"role": "assistant", "text": "How do hooks work?", "is_final": True},
                {"role": "user", "text": "Hooks let function components use state.", "is_final": True},
            ]
        })()
        memory_state = InterviewMemoryState(max_tail_items=4, summary_tail_lines=2)

        chat_ctx = _build_scripted_reply_chat_ctx(
            session=session,
            base_prompt="Base prompt",
            transcript=transcript,
            progress_tracker=tracker,
            memory_state=memory_state,
            runtime_control_provider=lambda: "Runtime control: continue interviewing.",
            wrap_up_authorized_provider=lambda: False,
        )

        text_items = [item.text_content for item in chat_ctx.items if getattr(item, "type", "") == "message"]
        self.assertEqual(text_items[0], "Base prompt")
        self.assertTrue(any("Interview memory:" in text for text in text_items))
        self.assertTrue(any("Runtime control: continue interviewing." in text for text in text_items))
        self.assertIn("assistant-4", text_items)
        self.assertIn("user-5", text_items)
        self.assertNotIn("assistant-0", text_items)
        self.assertLessEqual(len(chat_ctx.items), 7)

    async def test_generate_interview_reply_passes_compact_chat_ctx(self) -> None:
        tracker = InterviewProgressTracker({
            "skills": [{"skill": "React", "weightage": 100}],
            "durationMinutes": 20,
        })
        history = ChatContext()
        for idx in range(8):
            history.add_message(role="assistant", content=f"assistant-{idx}")
            history.add_message(role="user", content=f"user-{idx}")

        session = type("Session", (), {
            "history": history,
            "generate_reply": AsyncMock(),
        })()
        transcript = type("Transcript", (), {
            "lines": [
                {"role": "assistant", "text": "Explain React state.", "is_final": True},
                {"role": "user", "text": "State stores component data.", "is_final": True},
                {"role": "assistant", "text": "How do hooks work?", "is_final": True},
                {"role": "user", "text": "Hooks let function components use state.", "is_final": True},
            ]
        })()
        memory_state = InterviewMemoryState(max_tail_items=4, summary_tail_lines=2)

        await _generate_interview_reply(
            session=session,
            base_prompt="Base prompt",
            transcript=transcript,
            progress_tracker=tracker,
            memory_state=memory_state,
            runtime_control_provider=lambda: "Runtime control: continue interviewing.",
            wrap_up_authorized_provider=lambda: False,
            instructions="Ask the next question now.",
        )

        session.generate_reply.assert_awaited_once()
        kwargs = session.generate_reply.await_args.kwargs
        self.assertEqual(kwargs["instructions"], "Ask the next question now.")
        self.assertIn("chat_ctx", kwargs)
        chat_ctx = kwargs["chat_ctx"]
        text_items = [item.text_content for item in chat_ctx.items if getattr(item, "type", "") == "message"]
        self.assertEqual(text_items[0], "Base prompt")
        self.assertTrue(any("Interview memory:" in text for text in text_items))
        self.assertNotIn("assistant-0", text_items)
        self.assertIn("assistant-6", text_items)

    def test_build_interview_memory_message_returns_none_without_content(self) -> None:
        self.assertIsNone(
            build_interview_memory_message(
                earlier_summary="",
                pending_summary="none",
                runtime_gate_summary="none",
            )
        )

    def test_build_interview_memory_message_omits_pending_items_after_wrapup(self) -> None:
        message = build_interview_memory_message(
            earlier_summary="Earlier interviewer topics: React state.",
            pending_summary="React questions 7, 20",
            runtime_gate_summary="none",
            wrap_up_authorized=True,
        )
        self.assertIn("Wrap-up is already authorized by runtime.", message)
        self.assertNotIn("Required coverage still pending", message)

    def test_build_interview_memory_message_includes_anti_repeat_guidance(self) -> None:
        message = build_interview_memory_message(
            earlier_summary="Earlier interviewer topics: React state.",
            pending_summary="React coverage",
            runtime_gate_summary="React needs about 10.0 more min",
            anti_repeat_summary="Already asked on React: state vs props in react.",
        )
        self.assertIn("Already asked on React: state vs props in react.", message)

    async def test_prepared_verifier_allows_wrapup_when_missing_questions_stay_within_20_percent(self) -> None:
        meta = {
            "interviewMeta": {
                "questions": [{
                    "skill": "React",
                    "questions": [f"Q{i}" for i in range(1, 21)],
                }],
            }
        }
        provider_cfg = {"llm": {"provider": "openai", "api_key": "k", "model": "m"}}
        mocked = {
            "verifiedPreparedQuestions": [{"skill": "React", "questionNumbers": list(range(1, 19))}],
            "missingQuestions": [
                {"skill": "React", "questionNumber": 19, "question": "Q19"},
                {"skill": "React", "questionNumber": 20, "question": "Q20"},
            ],
            "readyForWrapup": False,
            "notes": "2 out of 20 prepared questions were not asked.",
        }
        with patch("app.pre_wrapup_verifier._eval_json", new=AsyncMock(return_value=mocked)):
            result = await verify_pre_wrapup_coverage(
                meta=meta,
                transcript_lines=[{"role": "assistant", "text": "Q1", "is_final": True}],
                provider_cfg=provider_cfg,
            )

        self.assertTrue(result.ready_for_wrapup)
        self.assertEqual(result.missing_items, [])
        self.assertIn(("React", 19), result.verified_question_marks)
        self.assertIn(("React", 20), result.verified_question_marks)
        self.assertIn("tolerance applied", result.notes.lower())

    async def test_prepared_verifier_blocks_wrapup_when_missing_questions_exceed_20_percent(self) -> None:
        meta = {
            "interviewMeta": {
                "questions": [{
                    "skill": "React",
                    "questions": [f"Q{i}" for i in range(1, 21)],
                }],
            }
        }
        provider_cfg = {"llm": {"provider": "openai", "api_key": "k", "model": "m"}}
        mocked = {
            "verifiedPreparedQuestions": [{"skill": "React", "questionNumbers": list(range(1, 16))}],
            "missingQuestions": [
                {"skill": "React", "questionNumber": 16, "question": "Q16"},
                {"skill": "React", "questionNumber": 17, "question": "Q17"},
                {"skill": "React", "questionNumber": 18, "question": "Q18"},
                {"skill": "React", "questionNumber": 19, "question": "Q19"},
                {"skill": "React", "questionNumber": 20, "question": "Q20"},
            ],
            "readyForWrapup": False,
            "notes": "5 out of 20 prepared questions were not asked.",
        }
        with patch("app.pre_wrapup_verifier._eval_json", new=AsyncMock(return_value=mocked)):
            result = await verify_pre_wrapup_coverage(
                meta=meta,
                transcript_lines=[{"role": "assistant", "text": "Q1", "is_final": True}],
                provider_cfg=provider_cfg,
            )

        self.assertFalse(result.ready_for_wrapup)
        self.assertEqual(len(result.missing_items), 5)


class SkillsHelpersTests(unittest.TestCase):
    def test_canonical_skill_key_normalizes_common_aliases(self) -> None:
        self.assertEqual(canonical_skill_key("React"), "react")
        self.assertEqual(canonical_skill_key("React.js"), "react")
        self.assertEqual(canonical_skill_key("Node"), "nodejs")
        self.assertEqual(canonical_skill_key("Node.js"), "nodejs")


if __name__ == "__main__":
    unittest.main()

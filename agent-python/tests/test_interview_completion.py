import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from app.provider_resolver import resolve_provider_cfg
from app.interview_progress import InterviewProgressTracker
from app.pre_wrapup_verifier import verify_pre_wrapup_coverage
from app.runner import _wait_for_drive_outcome, _wait_for_reconnect
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

    def test_mixed_plan_requires_questions_and_skills_without_questions(self) -> None:
        tracker = InterviewProgressTracker({
            "questions": [{
                "skill": "Core Java",
                "questions": ["Q1", "Q2"],
                "weightage": 70,
            }],
            "skills": [
                {"skill": "Core Java", "weightage": 70},
                {"skill": "SQL", "weightage": 30},
            ],
        })

        tracker.mark_question_asked("Core Java", 1)
        self.assertFalse(tracker.plan_completed.is_set())
        tracker.mark_question_asked("Core Java", 2)
        self.assertFalse(tracker.plan_completed.is_set())

        confirm_before_sql = tracker.confirm_plan_completed()
        self.assertTrue(confirm_before_sql.accepted)
        self.assertIn("Current tracker state", confirm_before_sql.message)
        self.assertTrue(tracker.completion_requested.is_set())
        authorize_before_sql = tracker.authorize_plan_completion()
        self.assertFalse(authorize_before_sql.accepted)
        self.assertIn("SQL coverage", authorize_before_sql.message)
        self.assertFalse(tracker.plan_completed.is_set())

        tracker.mark_skill_completed("SQL")
        self.assertFalse(tracker.plan_completed.is_set())

    def test_verified_corrections_can_release_wrapup(self) -> None:
        tracker = InterviewProgressTracker({
            "questions": [{
                "skill": "Core Java",
                "questions": ["Q1", "Q2"],
            }],
            "skills": [
                {"skill": "Core Java"},
                {"skill": "SQL"},
            ],
        })

        tracker.apply_verified_question_marks([("Core Java", 1), ("Core Java", 2)])
        tracker.apply_verified_skill_completions(["SQL"])
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


class PreWrapupVerifierTests(unittest.IsolatedAsyncioTestCase):
    async def test_verifier_short_circuits_when_no_structured_plan(self) -> None:
        result = await verify_pre_wrapup_coverage(
            meta={"interviewMeta": {}},
            transcript_lines=[],
            provider_cfg={},
        )
        self.assertTrue(result.ready_for_wrapup)
        self.assertEqual(result.missing_items, [])

    async def test_verifier_normalizes_missing_and_verified_items(self) -> None:
        meta = {
            "interviewMeta": {
                "questions": [{
                    "skill": "Core Java",
                    "questions": ["Q1", "Q2"],
                }],
                "skills": [{"skill": "SQL"}],
            }
        }
        transcript_lines = [
            {"role": "assistant", "text": "Q1", "is_final": True},
            {"role": "user", "text": "Answer", "is_final": True},
        ]
        provider_cfg = {"llm": {"provider": "openai", "api_key": "k", "model": "m"}}
        mocked = {
            "verifiedPreparedQuestions": [{"skill": "Core Java", "questionNumbers": [1]}],
            "verifiedSkills": [],
            "missingQuestions": [{"skill": "Core Java", "questionNumber": 2, "question": "Q2"}],
            "missingSkills": ["SQL"],
            "readyForWrapup": False,
            "notes": "Question 2 and SQL were not clearly covered.",
        }
        with patch("app.pre_wrapup_verifier._eval_json", new=AsyncMock(return_value=mocked)):
            result = await verify_pre_wrapup_coverage(
                meta=meta,
                transcript_lines=transcript_lines,
                provider_cfg=provider_cfg,
            )

        self.assertFalse(result.ready_for_wrapup)
        self.assertEqual(result.verified_question_marks, [("Core Java", 1)])
        self.assertEqual(len(result.missing_items), 2)
        self.assertEqual(result.missing_items[0]["type"], "question")
        self.assertEqual(result.missing_items[1]["type"], "skill")
        self.assertIn("SQL", result.notes)

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


class SkillsHelpersTests(unittest.TestCase):
    def test_canonical_skill_key_normalizes_common_aliases(self) -> None:
        self.assertEqual(canonical_skill_key("React"), "react")
        self.assertEqual(canonical_skill_key("React.js"), "react")
        self.assertEqual(canonical_skill_key("Node"), "nodejs")
        self.assertEqual(canonical_skill_key("Node.js"), "nodejs")


if __name__ == "__main__":
    unittest.main()

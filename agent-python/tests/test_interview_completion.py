import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from app.provider_resolver import resolve_provider_cfg
from app.interview_progress import InterviewProgressTracker
from app.pre_wrapup_verifier import verify_pre_wrapup_coverage
from app.runner import _wait_for_drive_outcome, _wait_for_reconnect


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

    def test_skills_only_complete_after_all_skills_marked(self) -> None:
        tracker = InterviewProgressTracker({
            "skills": [
                {"skill": "Core Java", "weightage": 60, "difficulty": "medium"},
                {"skill": "SQL", "weightage": 40, "difficulty": "easy"},
            ],
        })

        self.assertEqual(tracker.pending_summary(), "Core Java coverage; SQL coverage")
        first = tracker.mark_skill_completed("Core Java")
        self.assertTrue(first.accepted)
        self.assertFalse(first.plan_completed)
        self.assertIn("SQL coverage", first.message)

        second = tracker.mark_skill_completed("SQL")
        self.assertTrue(second.accepted)
        self.assertFalse(second.plan_completed)
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


if __name__ == "__main__":
    unittest.main()

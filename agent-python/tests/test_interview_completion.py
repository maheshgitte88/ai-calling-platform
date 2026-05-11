import asyncio
import unittest

from app.interview_progress import InterviewProgressTracker
from app.runner import _wait_for_drive_outcome


class InterviewProgressTrackerTests(unittest.TestCase):
    def test_prepared_questions_only_complete_after_all_questions(self) -> None:
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

        first = tracker.mark_question_asked("Core Java", 1)
        self.assertTrue(first.accepted)
        self.assertFalse(first.plan_completed)
        self.assertIn("2", first.message)

        second = tracker.mark_question_asked("Core Java", 2)
        self.assertTrue(second.accepted)
        self.assertTrue(second.plan_completed)
        self.assertTrue(tracker.plan_completed.is_set())

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
        self.assertTrue(second.plan_completed)
        self.assertTrue(tracker.plan_completed.is_set())

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
        self.assertFalse(confirm_before_sql.accepted)
        self.assertIn("SQL coverage", confirm_before_sql.message)

        tracker.mark_skill_completed("SQL")
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
        self.disconnected = asyncio.Event()


class WaitForDriveOutcomeTests(unittest.IsolatedAsyncioTestCase):
    async def test_completion_event_wins_before_timeout(self) -> None:
        tracker = _FakeTracker()
        plan_completed = asyncio.Event()

        async def trigger() -> None:
            await asyncio.sleep(0.01)
            plan_completed.set()

        asyncio.create_task(trigger())
        outcome = await _wait_for_drive_outcome(
            tracker=tracker,
            plan_completed=plan_completed,
            drive_seconds=1,
        )
        self.assertEqual(outcome, "plan_completed")

    async def test_disconnect_wins_before_completion(self) -> None:
        tracker = _FakeTracker()
        plan_completed = asyncio.Event()

        async def trigger() -> None:
            await asyncio.sleep(0.01)
            tracker.disconnected.set()

        asyncio.create_task(trigger())
        outcome = await _wait_for_drive_outcome(
            tracker=tracker,
            plan_completed=plan_completed,
            drive_seconds=1,
        )
        self.assertEqual(outcome, "candidate_disconnected")

    async def test_timeout_still_falls_back_when_no_completion_signal(self) -> None:
        tracker = _FakeTracker()
        plan_completed = asyncio.Event()

        outcome = await _wait_for_drive_outcome(
            tracker=tracker,
            plan_completed=plan_completed,
            drive_seconds=0,
        )
        self.assertEqual(outcome, "timeout")


if __name__ == "__main__":
    unittest.main()

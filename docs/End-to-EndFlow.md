Current architecture is now **two separate flows**, selected once from the payload at startup.

## Flow Selection

At the very beginning, the runtime normalizes `interviewMeta` and picks exactly one mode:

- `prepared_questions` if `interviewMeta.questions` exists
- `skills_only` if `interviewMeta.skills` / `skillWeights` exists
- if both are sent together, it raises an error

```97:122:agent-python/app/interview_plan.py
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
```

So now there is **no combined runtime flow** anymore.

## Example Payloads

Prepared-question flow payload:

```json
{
  "interviewMeta": {
    "durationMinutes": 20,
    "questions": [
      {
        "skill": "React",
        "questions": [
          "What are React Hooks?",
          "What is Redux and when would you use it?"
        ],
        "askFollowUps": true,
        "allowAdditional": false,
        "weightage": 100
      }
    ]
  }
}
```

Skills-only flow payload:

```json
{
  "interviewMeta": {
    "durationMinutes": 20,
    "skills": [
      {
        "skill": "Node.js",
        "topics": ["event loop", "streams", "async patterns"],
        "weightage": 100,
        "difficulty": "medium"
      }
    ]
  }
}
```

## Prompt Build

The prompt is built from the same shared base, but the mode-specific section is appended only for the active flow.

For `prepared_questions`, the prompt includes:
- prepared-question policy
- exact prepared questions
- `mark_question_asked`
- prepared-question execution rules

For `skills_only`, the prompt includes:
- skill plan
- difficulty policy
- `mark_skill_completed`
- skills-only execution rules

```526:552:agent-python/app/prompt.py
    if plan.mode == "skills_only":
        _append_block(lines, [SKILLS_WEIGHTAGE_POLICY])
        _append_block(lines, [build_difficulty_policy(candidate.get("yearsExperience"))])
        _append_block(lines, _skill_plan_lines(plan.skill_specs))

    # 8. Prepared questions per skill (policy + data, only when present) ------
    if plan.mode == "prepared_questions":
        _append_block(lines, [QUESTION_SOURCE_POLICY])
        _append_block(lines, _question_lines(plan.question_groups))

    # 9. Progress tracking tools (only when a structured plan exists) ----------
    progress_lines = _progress_tracking_lines(plan)
    if progress_lines:
        _append_block(lines, progress_lines)

    # 10. Flow-specific execution plan -----------------------------------------
    if plan.mode == "prepared_questions":
        execution_lines = _prepared_execution_plan_lines(plan.question_groups)
    elif plan.mode == "skills_only":
        execution_lines = _skills_only_execution_plan_lines(
            plan.skill_specs,
            candidate.get("yearsExperience"),
        )
```

And the two flow-specific prompt behaviors are different:

```288:346:agent-python/app/prompt.py
def _prepared_execution_plan_lines(question_groups: list[dict]) -> list[str]:
    ...
    lines.extend([
        "- Keep the greeting/readiness check brief; the main interview starts only after the candidate confirms they are ready.",
        "- Ask every required prepared question in the listed order before the interview plan can be treated as complete.",
        "- Candidate correctness, weakness, or non-response does not make an asked prepared question incomplete; coverage depends on whether you asked it.",
        "- Respect each skill group's follow-up and additional-question flags exactly.",
        "- Do not switch into wrap-up, closing, final-question mode, or conclusion mode on your own. Runtime alone will authorize that change.",
    ])
...
def _skills_only_execution_plan_lines(skill_specs: list[dict], years_experience) -> list[str]:
    ...
    lines.extend([
        "- No prepared question list is active. Generate technical questions from the skill plan, role, JD, and candidate background.",
        "- Stay on the current skill until runtime later accepts that the skill is complete.",
        "- If the candidate keeps responding, continue probing depth with fresh conceptual, practical, and scenario-based questions.",
        "- If the candidate gives repeated non-responses, simplify or vary the next technical question on the same skill. Do not conclude on your own.",
        "- Do not switch into wrap-up, closing, final-question mode, or conclusion mode on your own. Runtime alone will authorize that change.",
    ])
```

## Interview Start

When the interview starts:

1. `run_interview()` resolves durations and the plan mode.
2. It builds the base prompt.
3. It creates the correct agent class:
   - `PreparedQuestionsInterviewAgent`
   - `SkillsOnlyInterviewAgent`
4. It starts the session.
5. Runtime overlays current control state onto the prompt.
6. First AI turn is always just greeting + readiness check.

```769:790:agent-python/app/runner.py
async def run_interview(
    ctx: JobContext,
    meta: dict,
    *,
    settings: Settings | None = None,
) -> None:
    ...
    interview_meta = meta.get("interviewMeta") or {}
    durations = compute_durations(interview_meta)
    progress_tracker = InterviewProgressTracker(interview_meta)

    prompt = build_prompt(meta, plan=progress_tracker.plan)
    provider_cfg = resolve_provider_cfg(meta, cfg)
```

```529:551:agent-python/app/runner.py
    async def _apply_runtime_instructions(*, wrap_up_authorized: bool = False) -> None:
        remaining_minutes = None if wrap_up_authorized else max(0.0, drive_deadline - loop.time()) / 60.0
        await session.update_instructions(
            compose_runtime_instructions(
                base_prompt,
                plan_mode=progress_tracker.plan_mode,
                remaining_minutes=remaining_minutes,
                wrap_up_authorized=wrap_up_authorized,
            )
        )

    transcript.add_listener(_on_transcript_line)

    await _apply_runtime_instructions()
    await session.generate_reply(instructions=_initial_reply_instructions())
```

## Interview Drive Phase

The runtime computes:
- `total_seconds`
- `conclude_buffer_seconds`
- `drive_seconds`

```36:51:agent-python/app/metadata.py
def compute_durations(interview_meta: dict) -> InterviewDurations:
    ...
    total = max(_MIN_DURATION_SECONDS, min(_MAX_DURATION_SECONDS, duration_minutes * 60))
    conclude_buffer = min(_MAX_CONCLUDE_BUFFER_SECONDS, max(_MIN_CONCLUDE_BUFFER_SECONDS, total // 8))
    drive = max(_MIN_DRIVE_SECONDS, total - conclude_buffer)
    return InterviewDurations(
        total_seconds=total,
        conclude_buffer_seconds=conclude_buffer,
        drive_seconds=drive,
    )
```

During the drive phase, the runner waits for one of three things:
- candidate disconnect
- completion request from tracker
- drive timeout

```553:560:agent-python/app/runner.py
    while True:
        if tracker.connected.is_set():
            remaining_drive = max(0.0, drive_deadline - loop.time())
            outcome = await _wait_for_drive_outcome(
                tracker=tracker,
                completion_requested=progress_tracker.completion_requested,
                drive_seconds=remaining_drive,
            )
```

### Remaining time behavior
Before wrap-up authorization, runtime keeps updating the prompt with:

- remaining minutes
- “continue interviewing”
- “do not close”

```557:584:agent-python/app/prompt.py
def compose_runtime_instructions(
    base_prompt: str,
    *,
    plan_mode: PlanMode,
    remaining_minutes: float | None = None,
    wrap_up_authorized: bool = False,
) -> str:
    ...
    overlay = ["Runtime control state:"]
    if remaining_minutes is not None:
        overlay.append(f"- Remaining interview time before runtime wrap-up authorization: {_format_minutes(remaining_minutes)}.")
    overlay.extend([
        "- This timing information is internal runtime guidance. Do not say the remaining time aloud unless runtime explicitly tells you to.",
        "- Continue interviewing normally.",
        "- Do not close, conclude, wrap up, summarize the interview as finished, or ask final candidate questions unless runtime explicitly authorizes wrap-up.",
    ])
```

So the model sees time control every turn, but it is told **not to say it aloud**.

## Interview Progress State

### Prepared-question flow state
Tracker stores:
- required question numbers per skill
- completed question numbers per skill
- no pacing / nonresponse state

```212:229:agent-python/app/interview_progress.py
class _PreparedQuestionsProgressTracker(_BaseProgressTracker):
    def __init__(self, plan: InterviewPlan) -> None:
        super().__init__("prepared_questions")
        self._display_name_by_key: dict[str, str] = {}
        self._required_question_numbers: dict[str, set[int]] = {}
        self._completed_question_numbers: dict[str, set[int]] = {}
        self._skill_order: list[str] = []

        for group in plan.question_groups:
            ...
            self._required_question_numbers[key] = set(range(1, question_count + 1))
```

When AI asks a prepared question, it must call `mark_question_asked(skill, question_number)`.

Completion means:
- all required prepared questions were asked
- then AI calls `mark_interview_plan_completed()`
- runtime verifies the transcript
- if okay, wrap-up is authorized

### Skills-only flow state
Tracker stores:
- required skills
- completed skills
- active skill
- per-skill timing state
- nonresponse streak
- possible `time_gate_met` or `nonresponse_threshold`

```361:381:agent-python/app/interview_progress.py
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
```

Candidate responses update live pacing state:

```436:448:agent-python/app/interview_progress.py
    def note_candidate_response(self, text: str) -> None:
        key = self._ensure_active_skill_started()
        ...
        if self._is_nonresponse(text):
            state.consecutive_nonresponses += 1
        else:
            state.consecutive_nonresponses = 0
        self._refresh_runtime_eligibility(key)
        self._sync_runtime_nonresponse_wrapup_request(key)
```

So for `skills_only`, completion is not just “AI thinks skill is done.”  
It depends on runtime rules:
- enough elapsed time for that skill, or
- repeated nonresponses

## Wrap-up Verification

### Prepared-question flow verifier
Verifier checks only:
- did interviewer ask the required prepared questions?

It uses **assistant/interviewer transcript only**.

```12:33:agent-python/app/pre_wrapup_verifier.py
_PREPARED_VERIFY_SYSTEM_PROMPT = """
You verify prepared-question interview coverage before wrap-up. Reply with ONLY valid JSON.

Rules:
- Be strict. If a required prepared question is uncertain, treat it as missing.
- Use only the interviewer transcript to decide whether a required prepared question was clearly asked or an unmistakable equivalent was asked.
- Prepared-question coverage depends on whether the interviewer asked it, not on whether the candidate answered well, partially, incorrectly, or said "I don't know".
- Never mark a prepared question as missing just because the candidate could not answer it after it was asked.
```

### Skills-only flow verifier
Verifier checks only:
- did interviewer substantively cover the required skills?

```36:54:agent-python/app/pre_wrapup_verifier.py
_SKILLS_VERIFY_SYSTEM_PROMPT = """
You verify skills-only interview coverage before wrap-up. Reply with ONLY valid JSON.

Rules:
- Be strict. If a required skill is uncertain, treat it as missing.
- Use only the interviewer transcript to decide whether the interviewer substantively covered each skill.
- Candidate correctness does NOT determine whether a skill was covered.
```

And the dispatcher selects the right verifier by plan mode.

## Wrap-up

Wrap-up can start in two cases:

1. `plan_completed`
   - AI/tool requests completion
   - runtime verifies
   - tracker authorizes
   - runtime starts wrap-up

2. `timeout`
   - drive time ends
   - runtime directly authorizes wrap-up

Then runtime changes instructions to wrap-up-only mode and sends explicit wrap-up instructions.

```676:700:agent-python/app/runner.py
    if drive_outcome in ("timeout", "plan_completed"):
        reason = "plan_completed" if drive_outcome == "plan_completed" else "duration_elapsed"
        wrap_up_deadline = loop.time() + durations.conclude_buffer_seconds
        wrap_up_started = True
        ...
        if tracker.connected.is_set():
            await _apply_runtime_instructions(wrap_up_authorized=True)
            await session.generate_reply(
                instructions=_wrap_up_instruction_text(durations.conclude_buffer_seconds)
            )
```

And the overlay after authorization becomes:

```565:574:agent-python/app/prompt.py
    if wrap_up_authorized:
        flow_label = "prepared-question" if plan_mode == "prepared_questions" else "skills-only"
        overlay = [
            "Runtime control state:",
            f"- Active interview flow: {flow_label}.",
            "- Wrap-up is explicitly authorized by runtime.",
            "- Do not ask any new substantive technical interview questions.",
            "- Ask only final candidate questions, answer briefly, and close politely.",
        ]
```

## End-to-End Summary

### Prepared-question flow
1. Payload contains `questions`
2. Mode becomes `prepared_questions`
3. Prompt includes exact prepared questions
4. Agent exposes:
   - `mark_question_asked`
   - `mark_interview_plan_completed`
5. AI asks required prepared questions in order
6. Each asked question is tracked
7. AI requests completion
8. Verifier checks interviewer-only transcript for asked questions
9. Runtime authorizes wrap-up
10. Runtime pushes wrap-up instructions

### Skills-only flow
1. Payload contains `skills`
2. Mode becomes `skills_only`
3. Prompt includes skill plan only
4. Agent exposes:
   - `mark_skill_completed`
   - `mark_interview_plan_completed`
5. AI keeps interviewing on active skill
6. Runtime tracks:
   - elapsed skill time
   - nonresponse streak
7. AI can only complete skill when runtime gate allows it
8. AI requests completion
9. Verifier checks interviewer-only skill coverage
10. Runtime authorizes wrap-up, or timeout authorizes it

## Important behavior difference

The biggest difference now is:

- In `prepared_questions`, **coverage = interviewer asked the required question**
- In `skills_only`, **coverage = runtime pacing + interviewer substantively covered the skill**

So the two flows are now separate in:
- payload parsing
- prompt construction
- tool exposure
- tracker state
- verifier logic
- wrap-up authorization path

If you want, next I can draw this as a compact flowchart for both modes side by side.
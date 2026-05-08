Here's how the evaluation works end-to-end, plus two issues I noticed that landed when we changed the question/topic shapes recently.

### Flow at a glance

```
Interview ends (candidate disconnect or duration timeout + wrap-up)
   │
   ▼
runner.run_interview()
   │  transcript.lines  ← captured live by TranscriptRecorder
   │  meta              ← original dispatch metadata (candidate, JD, skills, questions, …)
   │  provider_cfg      ← LLM/STT/TTS config (which provider key + model to use)
   ▼
evaluation.generate_structured_evaluation(transcript_lines, meta, provider_cfg)
   │  1. format transcript chronologically
   │  2. build user prompt (interview context + transcript)
   │  3. call evaluator LLM → strict JSON
   │  4. clamp summary, normalize verdicts, deterministic scoring
   ▼
runner._persist_evaluation()
   │  → MongoDB:
   │     interview_evaluations  (the evaluation document)
   │     interview_sessions     (status="completed")
```

### Step 1 — transcript is rendered chronologically

`format_transcript_chronological(transcript_lines)` keeps only:

- assistant lines
- final user lines (intermediate STT partials are skipped)

…in order:

```
Interviewer: ...
Candidate: ...
Interviewer: ...
Candidate: ...
```

### Step 2 — user prompt is built

`_build_user_prompt(meta, transcript_text)` packs:

- Interview title
- Role / JD title + first 1200 chars of JD body
- Must-ask topics
- Planned / reference questions (if any)
- Candidate profile (years experience + skills)
- Full chronological transcript

### Step 3 — evaluator LLM call

The system prompt instructs the LLM to return strict JSON in this exact shape:

```json
{
  "executiveSummary": "string (50-60 words, qualitative narrative only)",
  "questions": [
    { "question": "...", "answer": "...", "verdict": "correct | partially_correct | incorrect | could_not_answer" }
  ],
  "dimensionScores": { "communication": 0-100, "technicalDepth": 0-100, "problemSolving": 0-100 }
}
```

Provider routing in `_call_eval_llm` supports:

- `openai` → OpenAI Chat Completions with `response_format=json_object`
- `gemini` → Google Generative AI with `response_mime_type=application/json`
- `deepseek` → OpenAI-compatible at `https://api.deepseek.com/v1`
- `xai` / `grok` → OpenAI-compatible at `https://api.x.ai/v1`

Temperature is `0.2` everywhere for stable structured output.

If the call fails or the JSON can't be parsed, a `_FALLBACK_RESULT` is used (empty questions, zero scores, generic summary) so the rest of the pipeline never crashes.

### Step 4 — deterministic scoring on top of LLM verdicts

The LLM's free-text scores are **not trusted directly for the overall %**. After parsing:

- `executiveSummary` → trimmed and clamped to 60 words.
- `dimensionScores` → each clamped to 0–100 ints (NaN/garbage → 0).
- `questions[]` → each verdict string normalised through `VERDICT_ALIASES` (handles "partial", "wrong", "no answer", etc.) → falls back to `could_not_answer` if unknown.

Then `score_questions()` runs a **deterministic** pass:

```
per-question max  = 100 / N
multiplier        = correct: 1.0, partially_correct: 0.5, incorrect: 0.0, could_not_answer: 0.0
overallPercent    = Σ(per * multiplier), rounded to 2 decimals
```

And `recommendation_from_overall(overall)`:

| `overallPercent` | recommendation |
|---|---|
| ≥ 70 | `shortlist` |
| 50 – 69.99 | `hold` |
| < 50 | `reject` |

So even if the LLM is inconsistent, the overall % and recommendation are reproducible from the verdict counts.

### Step 5 — persisted document

`_persist_evaluation()` upserts into `interview_evaluations` keyed by `session_id`:

```text
session_id, candidate_id, interview_id, status="completed",
summary, questions[], overallPercent, questionStats { total, correct, partially_correct, incorrect, could_not_answer },
scores { communication, technicalDepth, problemSolving },
strengths[], gaps[],          # derived from questionStats by _basic_signals_from_stats
recommendation,
completed_at
```

And bumps the parent session row to `status="completed"`.

### Two issues I noticed in the eval user prompt

When we restructured `questions` (per-skill groups) and `mustAskTopics` (with `askNow` flag), the **agent's evaluation prompt builder was not updated**. It still treats them as flat string arrays:

```222:252:c:\AIVoiceAgents\ai-calling-platform\agent-python\app\evaluation.py
def _build_user_prompt(meta: dict, transcript_text: str) -> str:
    ...
    must_ask = interview_meta.get("mustAskTopics") or []
    planned_questions = interview_meta.get("questions") or []
    ...
    plan_q = "\n".join(f"  - {q}" for q in planned_questions) if planned_questions else "N/A"
    ...
    f"Must-ask topics: {', '.join(must_ask) if must_ask else 'N/A'}\n"
    f"Planned / reference questions ...:\n{plan_q}\n"
```

With the new shapes, `q` is a dict like `{ skill, questions, askFollowUps, allowAdditional }` and `must_ask` items are `{ topic, askNow }`, so the eval prompt currently shows the LLM things like:

```
Must-ask topics: {'topic': 'System design', 'askNow': True}, {'topic': 'Testing', 'askNow': False}
Planned / reference questions ...:
  - {'skill': 'JavaScript', 'questions': ['Explain the JS event loop.', 'What is a closure?'], ...}
```

Functionally it doesn't crash — the LLM still has the transcript and produces an evaluation — but the planned-questions context is now noisy / harder to align verdicts against. **Want me to fix it to flatten the new structures back to readable strings for the eval prompt?** It's a ~10-line change to `_build_user_prompt`.
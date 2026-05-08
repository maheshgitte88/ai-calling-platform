All five pillars are implemented and verified end-to-end. Here's what now happens.

### What changed

**`agent-python/app/evaluation.py`** — full rewrite (back-compat keys preserved):

1. **Two-pass evaluation (CoT → JSON)** — Pass 1 asks the LLM for a free-text analysis (which Q probed which skill, substance vs style). Pass 2 produces strict JSON given that analysis. Pass 1 failures don't block Pass 2.
2. **Multi-criterion 0–4 scoring per question** on three independent axes: `accuracy`, `depth`, `practical`. Per-question score = `(0.5·accuracy + 0.3·depth + 0.2·practical) × 25` → 0..100. Legacy `verdict` is *derived* from the score, so the existing dashboard still renders.
3. **Anti-bias system prompt** — explicit lines tell the judge to score substance only; communication is captured separately at the dimension level so it never bleeds into per-question scores.
4. **Skill-weighted overall** — exactly your formula:
   - `per_skill_score = mean(question_scores_in_that_skill)` (NOT count-based).
   - `overall = Σ(skill_score × weightage) / Σ(weightages_with_data)`.
   - Falls back to flat mean if no weights, or skill-mean if some scored skills had no weights.
5. **Self-consistency flags + auto-downgrade**:
   - `style_over_substance` (comm ≥ 80 ∧ technicalDepth ≤ 30) → drops recommendation by one tier.
   - `summary_says_weak_but_score_high`, `summary_says_strong_but_score_low` → flagged.
   - `uncovered_weighted_skills:X,Y` → coverage gap surfaced, but candidate isn't penalised (renormalised).

**`agent-python/app/runner.py`** — `_persist_evaluation` now also writes `perSkillScores`, `skillWeights`, `evaluationFlags` to MongoDB.

**`backend-node/src/interviews/schemas.js`** — `InterviewQuestionGroupSchema` accepts an optional `weightage`.

**`backend-node/src/interviews/normalize.js`** — `normalizeInterviewQuestionGroups` parses and carries `weightage` through to dispatch metadata.

**`dashboard-react/src/pages/InterviewCandidate.jsx`** — `QuestionGroupsSection` now has a `Weightage %` input next to `Skill`; the description explicitly says it is consumed by the evaluation, not by the live interviewer.

### Important: the weightage on question groups is NOT in the live prompt

I checked `app/prompt.py`'s `_question_lines` rendering — it only emits `Skill | ask_follow_ups | allow_additional` and the questions themselves. `weightage` flows only into the dispatch metadata and is read directly by `evaluation.resolve_skill_weights(meta)`. The AI interviewer never sees it during the interview, exactly as you asked.

### Verified math (your exact 20/30/50 example)

```text
Mode B — 3 skills, weights 20% / 30% / 50%
  Skill A  weightage 20%  questions=[(4,4,4)]                 → mean = 100
  Skill B  weightage 30%  questions=[(3,3,3),(2,2,2),(1,1,1)] → mean =  50  (NOT count-based)
  Skill C  weightage 50%  questions=[(0,0,0),(4,4,4)]         → mean =  50

overall = 0.2×100 + 0.3×50 + 0.5×50 = 20 + 15 + 25 = 60.0  ✓
```

```text
Mode A — prepared questions, weightage on the QUESTION groups (50/50)
  Node.js   50%  Q=(4,3,2) → score 82.5  → per_skill 82.5
  React.js  50%  Q=(2,1,0) → score 32.5  → per_skill 32.5

overall = 0.5×82.5 + 0.5×32.5 = 57.5  ✓
```

```text
Uncovered skill — Skill C (50%) was never asked
  → flag: uncovered_weighted_skills:C
  → overall renormalised over only Skill A and B:
    overall = (0.2×75 + 0.3×50) / (0.2+0.3) = 30 / 0.5 = 60.0  ✓
  → candidate NOT penalised for the AI not asking
```

```text
Style-over-substance auto-downgrade
  raw overall:  72  (would be 'shortlist')
  comm 90, tech 25 → flag: style_over_substance
  recommendation → 'hold'  ✓
```

### MongoDB document fields after this PR

```text
session_id, candidate_id, interview_id, status="completed", completed_at,
summary,                        // unchanged: 50–60 word qualitative narrative
questions[],                    // each item now also carries: skillScored, accuracy, depth, practical, score, rationale
overallPercent,                 // unchanged key — now skill-weighted as described above
questionStats,                  // unchanged: legacy verdict counts (derived from new scores)
scores,                         // unchanged: { communication, technicalDepth, problemSolving }
strengths[], gaps[],            // unchanged: derived from questionStats by _basic_signals_from_stats
recommendation,                 // unchanged key — auto-downgraded when consistency flags fire
perSkillScores,    // NEW — { "Node.js": 82.5, "React.js": 32.5 }
skillWeights,      // NEW — { "Node.js": 50, "React.js": 50 }
evaluationFlags,   // NEW — ["style_over_substance", "uncovered_weighted_skills:C", ...]
```

Existing dashboard reads keep working untouched. New fields are additive — wire them into the UI whenever you're ready (one obvious next step: a per-skill bar chart on the evaluation page, plus a small badge that turns red when `evaluationFlags` is non-empty).

### What's verified

- `py_compile` on `evaluation.py` + `runner.py` ✓
- `node --check` on backend files + `import('./src/app.js')` smoke load ✓
- `npm run build` on dashboard ✓
- Lint clean across all touched files ✓
- Deterministic math reproduces your exact 20/30/50 example with overall = 60 ✓
- Mode A path (weightage on question groups) computes overall correctly ✓
- Uncovered-skill renormalisation works (no false zeros, flag surfaced) ✓
- `style_over_substance` flag downgrades recommendation as designed ✓

Two follow-ups you might want next (optional, not done now):

1. **Surface `perSkillScores` and `evaluationFlags` in the dashboard** — small change in `Interviews.jsx` / evaluation render to add a per-skill bar and a flag badge.
2. **Let employers attach a key-points checklist per prepared question** — strongest accuracy lever. Schema change + UI change + ~20 LOC in eval to score "covered points / total key points".

Say the word and I'll wire either or both.



Full walkthrough using a worked example. I'll trace **one Node.js question** end-to-end, then show how it rolls up into the final score.

## Stage 1 — What the LLM evaluator sees per interview

The evaluator gets, in this order:

1. **Skill list** with weightages (so it knows which skills exist and how to tag).
2. **Must-ask topics** + **prepared questions** + **JD title/text** + **candidate experience/skills** (context).
3. **Pass-1 internal analysis** (its own free-text reasoning from the previous pass).
4. **Full chronological transcript**.

The evaluator does **not** see scoring instructions until Pass 2 — Pass 1 is just "read and explain".

## Stage 2 — Per-question scoring (the core calculation)

Each substantive Q&A in the transcript gets scored on **three independent 0–4 axes**:

| Axis | What it measures | Score 4 means | Score 0 means |
|---|---|---|---|
| `accuracy` | Is the technical content right? | All key points correct + concrete | Refused / wrong on all key points |
| `depth` | Reasoning, trade-offs, edge cases | Mentions multiple trade-offs + specifics | Surface only, no depth |
| `practical` | Real-world examples / applicability | Concrete shipped examples | None |

**Style/fluency is intentionally NOT in any axis.** Communication is captured *only* at the dimension level (next stage).

### Worked example: a single Node.js question

**Q1:** *"What is the event loop in Node.js?"*

**Candidate's transcribed answer:** *"The event loop is what handles async stuff in Node. It runs in phases — timers, pending callbacks, poll, check, close — and microtasks like promises run between phases. I've used it when debugging a memory leak from setInterval that wasn't being cleared, the timers phase kept running."*

The LLM scores:

```text
accuracy  = 3   (correctly named the phases, microtask interleaving correct, minor: didn't mention nextTick priority)
depth     = 3   (identified ordering of phases + microtask boundary; didn't go into libuv internals)
practical = 4   (concrete real-world example: setInterval debugging)
skillScored = "Node.js"
rationale = "Phases named correctly, microtask interleaving accurate; concrete debugging example."
```

### Per-question 0..100 score formula

```text
score = (0.5·accuracy + 0.3·depth + 0.2·practical) × 25
      = (0.5×3      + 0.3×3      + 0.2×4)        × 25
      = (1.5        + 0.9        + 0.8)          × 25
      = 3.2                                       × 25
      = 80.0
```

### Verdict (legacy four-bucket, derived from score)

```text
score ≥ 80  →  correct
score ≥ 40  →  partially_correct
score >  0  →  incorrect
score = 0   →  could_not_answer
```

So `Q1 → score 80 → verdict = correct`.

### Why the formula works against the bias you described

- **Fluent speaker, shallow content.** A candidate who *sounds* great but says "the event loop runs JavaScript asynchronously" with no specifics:
  ```text
  accuracy=2, depth=1, practical=0
  → (0.5×2 + 0.3×1 + 0.2×0) × 25 = 1.3 × 25 = 32.5  →  incorrect
  ```
  The LLM cannot inflate this with style points because none of the three axes reward fluency.

- **Plain speaker, technically excellent content.** Awkwardly phrased but covers all key points + trade-offs + example:
  ```text
  accuracy=4, depth=4, practical=4
  → (0.5×4 + 0.3×4 + 0.2×4) × 25 = 4 × 25 = 100  →  correct
  ```
  Communication score (separate, dimension-level) might be 50 because of awkward phrasing — but the per-question technical score is still 100.

## Stage 3 — Per-skill aggregation (mean, NOT count-based)

Pretend the full evaluated set is:

| # | Question | skillScored | accuracy | depth | practical | score |
|---|---|---|---|---|---|---|
| 1 | event loop? | Node.js | 3 | 3 | 4 | 80.0 |
| 2 | promises vs async/await? | Node.js | 4 | 3 | 2 | 82.5 |
| 3 | streams pipe()? | Node.js | 2 | 2 | 1 | 45.0 |
| 4 | class vs functional component? | React.js | 3 | 2 | 2 | 65.0 |
| 5 | useEffect cleanup? | React.js | 1 | 1 | 0 | 20.0 |

**Per-skill score = simple mean of the question scores in that skill** (it does NOT depend on how many questions there are):

```text
Node.js  = (80.0 + 82.5 + 45.0) / 3 = 69.17
React.js = (65.0 + 20.0)        / 2 = 42.50
```

This is exactly the rule you asked for: 5 questions vs 1 question doesn't matter — the *mean* of whatever was asked stands for that skill.

## Stage 4 — Skill-weighted overall %

Suppose your interview was set up as:

```text
Node.js   weightage 50%
React.js  weightage 50%
```

Overall %:

```text
weighted_sum = 50 × 69.17  +  50 × 42.50  =  3458.5  +  2125.0  =  5583.5
total_w      = 50          +  50           =                       100
overall      = weighted_sum / total_w      =  5583.5  / 100      =   55.84
```

That `55.84` is `overallPercent` written into MongoDB. Note carefully:

- **Number of questions does NOT factor into overall.** Skill-mean × skill-weight is the only thing that matters once every skill has at least one question.
- If a weighted skill had **zero** questions in the transcript, its weight is **excluded from `total_w`** so the overall renormalises (you saw this in the previous turn).

### Different example — your 20% / 30% / 50% case

| Skill | Weight | Mean of question scores | Contribution |
|---|---|---|---|
| A | 20% | 100 | 20 × 100 = 2000 |
| B | 30% | 50 | 30 × 50 = 1500 |
| C | 50% | 50 | 50 × 50 = 2500 |
| **Total** | **100%** | | **6000** |

`overall = 6000 / 100 = 60.0`. Verified earlier in the math smoke test.

## Stage 5 — Dimension scores (separate from per-question)

The same Pass-2 LLM call also returns three independent 0..100 dimension scores for the **whole interview**:

| Dimension | What it measures | Important property |
|---|---|---|
| `communication` | Fluency, grammar, clarity | The *only* place style is rewarded. |
| `technicalDepth` | Overall technical accuracy across the interview | Independent of how the candidate spoke. |
| `problemSolving` | Applied / scenario reasoning | Independent of style. |

These are clipped to integers in `[0, 100]` and stored as `scores`.

## Stage 6 — Self-consistency flags

After scoring, deterministic checks run:

```text
1. summary text says "weak/inadequate/poor/struggled" + overall ≥ 70   →  summary_says_weak_but_score_high
2. summary text says "strong/excellent/great"        + overall < 40   →  summary_says_strong_but_score_low
3. communication ≥ 80  AND  technicalDepth ≤ 30                       →  style_over_substance
4. technicalDepth ≥ 80  AND  communication ≤ 30                       →  substance_over_style
5. any weighted skill has zero scored questions                       →  uncovered_weighted_skills:X,Y
```

Flags 1 and 3 (the inflation-toward-shortlist ones) **auto-downgrade the recommendation by one tier** so a fluent shallow candidate can't accidentally land in `shortlist`:

```text
shortlist  →  hold
hold       →  reject
```

Flag 4 (`substance_over_style`) and the coverage flag don't auto-downgrade — they're informational.

## Stage 7 — Recommendation thresholds

Run on `overallPercent` after any flag downgrade:

```text
overall ≥ 70  →  shortlist
overall ≥ 50  →  hold
overall <  50 →  reject
```

So the example above (overall = 55.84, no inflation flags) → `hold`.

## Stage 8 — Question stats (back-compat)

Computed deterministically from the verdicts derived in Stage 2:

```text
questionStats = {
  total: 5,
  correct: 2,            // q1 (80), q2 (82.5)
  partially_correct: 2,  // q3 (45), q4 (65)
  incorrect: 1,          // q5 (20)
  could_not_answer: 0
}
```

The dashboard's existing question-stats card keeps rendering identically.

## What the persisted document looks like for the example above

```jsonc
{
  "summary": "Solid Node.js fundamentals with concrete debugging examples. React understanding is shallow — useEffect cleanup gap is concerning for the role. Communication clear throughout.",
  "questions": [
    { "question": "event loop?", "answer": "...", "skillScored": "Node.js",
      "accuracy": 3, "depth": 3, "practical": 4, "score": 80.0,
      "verdict": "correct", "rationale": "Phases named correctly..." },
    { "question": "promises vs async/await?", "skillScored": "Node.js",
      "accuracy": 4, "depth": 3, "practical": 2, "score": 82.5,
      "verdict": "correct", "rationale": "..." },
    { "question": "streams pipe()?", "skillScored": "Node.js",
      "accuracy": 2, "depth": 2, "practical": 1, "score": 45.0,
      "verdict": "partially_correct", "rationale": "..." },
    { "question": "class vs functional component?", "skillScored": "React.js",
      "accuracy": 3, "depth": 2, "practical": 2, "score": 65.0,
      "verdict": "partially_correct", "rationale": "..." },
    { "question": "useEffect cleanup?", "skillScored": "React.js",
      "accuracy": 1, "depth": 1, "practical": 0, "score": 20.0,
      "verdict": "incorrect", "rationale": "..." }
  ],
  "perSkillScores":  { "Node.js": 69.17, "React.js": 42.50 },
  "skillWeights":    { "Node.js": 50,    "React.js": 50    },
  "overallPercent":  55.84,
  "scores":          { "communication": 75, "technicalDepth": 55, "problemSolving": 50 },
  "questionStats":   { "total": 5, "correct": 2, "partially_correct": 2, "incorrect": 1, "could_not_answer": 0 },
  "evaluationFlags": [],
  "recommendation":  "hold"
}
```

## Summary of the core formulas in one place

```text
# Per-question (0..100, 3 independent axes 0..4)
score_q       = (0.5·accuracy + 0.3·depth + 0.2·practical) × 25
verdict_q     = score_q ≥ 80 ? correct : score_q ≥ 40 ? partially_correct
              : score_q > 0  ? incorrect : could_not_answer

# Per-skill (mean of question scores in that skill — count-independent)
score_skill_S = Σ score_q  for q where skillScored == S   /   N_questions_in_S

# Overall (skill-weight average; renormalised over skills with data)
overall %     = Σ (score_skill_S × weight_S)  /  Σ weight_S        for S in scored skills

# Dimensions (independent, 0..100)
communication, technicalDepth, problemSolving        # not used in overall %

# Recommendation thresholds (after possible flag downgrade)
overall ≥ 70 → shortlist  ;  overall ≥ 50 → hold  ;  else reject
```

That's the full pipeline. Every number on an evaluation page can be traced to one of these formulas, and you can hand-verify any score by reading the Q&A pair and the three axis scores in `questions[]`.
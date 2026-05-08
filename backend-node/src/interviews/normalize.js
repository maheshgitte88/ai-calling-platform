/**
 * Normalisation helpers for interview-session payloads.
 *
 * Each function takes user-supplied input (potentially missing, wrongly
 * typed, mixed shapes) and returns a clean canonical structure the rest of
 * the pipeline (and the agent prompt) can rely on.
 *
 * All structured shapes here are forward-compatible: callers may also pass
 * legacy flat string arrays and the helpers will lift them into the new
 * structure with sensible defaults.
 */

const ALLOWED_DIFFICULTIES = new Set(["easy", "medium", "hard"]);

// ---------------------------------------------------------------------------
// Language policy
// ---------------------------------------------------------------------------

/**
 * Resolve the effective language policy for an interview.
 *
 * Priority: `interviewMeta.languagePolicy` (array) > `interviewRules.languagePolicy`
 * (array or comma/semicolon-delimited string) > `[primaryLanguage]`.
 *
 * @param {Record<string, unknown> | undefined} interviewMeta
 * @param {Record<string, unknown> | undefined} interviewRules
 * @param {string} primaryLanguage
 * @returns {string[]}
 */
export function normalizeInterviewLanguagePolicy(interviewMeta, interviewRules, primaryLanguage) {
  const primary = String(primaryLanguage || "en").trim().toLowerCase() || "en";

  const metaArr = interviewMeta?.languagePolicy;
  if (Array.isArray(metaArr) && metaArr.length > 0) {
    const out = [...new Set(metaArr.map((c) => String(c).trim().toLowerCase()).filter(Boolean))];
    if (out.length) return out;
  }

  const rulesPol = interviewRules?.languagePolicy;
  if (Array.isArray(rulesPol) && rulesPol.length > 0) {
    const out = [...new Set(rulesPol.map((c) => String(c).trim().toLowerCase()).filter(Boolean))];
    if (out.length) return out;
  }
  if (typeof rulesPol === "string" && rulesPol.trim()) {
    const out = [
      ...new Set(
        rulesPol.split(/[,;]/).map((s) => s.trim().toLowerCase()).filter(Boolean),
      ),
    ];
    if (out.length) return out;
  }

  return [primary];
}

// ---------------------------------------------------------------------------
// Skill plan
// ---------------------------------------------------------------------------

function parseWeightage(raw) {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) {
    const parsed = Number(raw.replace("%", "").trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function parseDifficulty(raw) {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  return ALLOWED_DIFFICULTIES.has(v) ? v : null;
}

/**
 * Coerce raw skill entries into the canonical
 * `{ skill, topics, weightage, difficulty, instructions }` shape.
 *
 * Accepts strings (just the skill name) or full objects. Unknown fields
 * are dropped; missing fields fall back to safe defaults.
 */
export function normalizeInterviewSkillSpecs(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (typeof item === "string") {
      const name = item.trim();
      if (!name) continue;
      out.push({ skill: name, topics: [], weightage: null, difficulty: null, instructions: "" });
      continue;
    }
    if (!item || typeof item !== "object") continue;

    const skill = String(item.skill || item.name || "").trim();
    if (!skill) continue;

    const topics = Array.isArray(item.topics)
      ? item.topics.map((t) => String(t).trim()).filter(Boolean)
      : [];

    const weightage = parseWeightage(item.weightage);
    const difficulty = parseDifficulty(item.difficulty);
    const instructions = typeof item.instructions === "string" ? item.instructions.trim() : "";

    out.push({ skill, topics, weightage, difficulty, instructions });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Prepared questions (per-skill groups, with legacy fallback)
// ---------------------------------------------------------------------------

const LEGACY_QUESTION_GROUP_SKILL = "General";

/**
 * Normalize prepared questions into per-skill groups:
 *
 *     [{ skill, questions: string[], askFollowUps: bool, allowAdditional: bool }, …]
 *
 * Accepts:
 *  - `string[]`  (legacy) — wrapped into a single "General" group with
 *    `askFollowUps=true`, `allowAdditional=false`.
 *  - `Array<string | { skill, questions, askFollowUps?, allowAdditional? }>`
 *    — strings inside the array are merged into a single trailing
 *      "General" group, structured entries are kept as-is.
 *
 * Empty groups (no questions after trimming) are dropped.
 */
export function normalizeInterviewQuestionGroups(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return [];

  const groups = [];
  const generalQuestions = [];

  for (const item of raw) {
    if (typeof item === "string") {
      const trimmed = item.trim();
      if (trimmed) generalQuestions.push(trimmed);
      continue;
    }
    if (!item || typeof item !== "object") continue;

    const skill = String(item.skill || item.name || "").trim();
    if (!skill) continue;

    const questions = Array.isArray(item.questions)
      ? item.questions.map((q) => String(q).trim()).filter(Boolean)
      : [];
    if (questions.length === 0) continue;

    groups.push({
      skill,
      questions,
      askFollowUps: typeof item.askFollowUps === "boolean" ? item.askFollowUps : true,
      allowAdditional: typeof item.allowAdditional === "boolean" ? item.allowAdditional : false,
      // `weightage` is consumed only by the post-interview evaluation; we
      // intentionally do not surface it to the live interviewer prompt.
      weightage: parseWeightage(item.weightage),
    });
  }

  if (generalQuestions.length > 0) {
    groups.push({
      skill: LEGACY_QUESTION_GROUP_SKILL,
      questions: generalQuestions,
      askFollowUps: true,
      allowAdditional: false,
      weightage: null,
    });
  }

  return groups;
}

// ---------------------------------------------------------------------------
// Must-ask topics (with priority flag, legacy fallback)
// ---------------------------------------------------------------------------

/**
 * Normalize must-ask topics into `[{ topic, askNow }, …]`.
 *
 * Accepts plain strings (legacy) or `{ topic, askNow }` objects.
 * `askNow` defaults to `false` (normal flow) when not provided.
 */
export function normalizeInterviewMustAskTopics(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    let topic;
    let askNow = false;
    if (typeof item === "string") {
      topic = item.trim();
    } else if (item && typeof item === "object") {
      topic = String(item.topic || "").trim();
      askNow = Boolean(item.askNow);
    }
    if (!topic) continue;
    const key = topic.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ topic, askNow });
  }
  return out;
}

import { z } from "zod";

/**
 * Zod schemas for interview-session API payloads.
 *
 * Field names mirror the dashboard form so clients can send the structured
 * form values directly. Backwards-compatible "legacy" shapes (plain string
 * arrays) are still accepted so older callers and saved interviews keep
 * working.
 */

// Difficulty levels supported per skill. Lowercase for stable comparisons.
export const SkillDifficultyEnum = z.enum(["easy", "medium", "hard"]);

/**
 * One skill in the interviewer's skill plan.
 *
 * - `topics`: focus areas inside the skill (optional list).
 * - `weightage`: percentage of interview time/focus to spend on the skill.
 * - `difficulty`: hint to the AI on how deep questions on this skill go.
 * - `instructions`: free-text guidance for *this* skill specifically
 *   (e.g. "Ask beginner-level conceptual + practical questions").
 */
export const InterviewSkillSpecSchema = z.object({
  skill: z.string().min(1),
  topics: z.array(z.string().min(1)).optional(),
  weightage: z.union([z.number(), z.string()]).optional(),
  difficulty: SkillDifficultyEnum.optional(),
  instructions: z.string().max(2000).optional(),
});

/**
 * A skill-scoped block of prepared questions.
 *
 * - `questions`: ordered list of questions the AI must ask for this skill.
 * - `askFollowUps`: when true, AI may ask 1-2 brief follow-ups per question.
 * - `allowAdditional`: when true, AI may ask extra questions on this skill
 *   *after* the prepared list is finished, if time permits.
 */
export const InterviewQuestionGroupSchema = z.object({
  skill: z.string().min(1),
  questions: z.array(z.string().min(1).max(4000)).default([]),
  askFollowUps: z.boolean().optional(),
  allowAdditional: z.boolean().optional(),
});

/**
 * A must-ask topic with a priority flag.
 *
 * - `askNow: true`  → high priority, AI should cover this topic early.
 * - `askNow: false` → normal flow, cover whenever it fits naturally.
 */
export const MustAskTopicSchema = z.object({
  topic: z.string().min(1),
  askNow: z.boolean().optional(),
});

export const StartInterviewSessionSchema = z.object({
  candidateId: z.string().min(1),
  interviewId: z.string().min(1),
  /** Link validity window (optional). Use either hours or days. */
  linkExpiryHours: z.number().positive().max(24 * 30).optional(),
  linkExpiryDays: z.number().positive().max(30).optional(),
  /** Recording toggle: true => record full room via LiveKit Egress. */
  recordingEnabled: z.boolean().optional(),
  recordingLayout: z.string().optional(),
  recordingAudioOnly: z.boolean().optional(),
  candidate: z
    .object({
      name: z.string().optional(),
      email: z.string().optional(),
      yearsExperience: z.coerce.number().nonnegative().optional(),
      skills: z.array(z.string()).optional(),
      /**
       * Free-text resume summary (a short narrative or paste from the
       * candidate's resume). Used by the AI to tailor questions and
       * follow-ups to the candidate's actual background.
       */
      resumeSummary: z.string().max(20000).optional(),
    })
    .partial()
    .optional(),
  interviewMeta: z
    .object({
      title: z.string().optional(),
      /** Primary conversation language (STT/TTS bias), e.g. en */
      language: z.string().optional(),
      /** Allowed language codes (multilingual policy), e.g. ["en","hi"] */
      languagePolicy: z.array(z.string().min(2).max(16)).optional(),
      durationMinutes: z.number().int().positive().max(180).optional(),
      /**
       * Must-ask topics. Either `string[]` (legacy) or structured rows with
       * a per-topic priority flag (preferred).
       */
      mustAskTopics: z
        .array(z.union([z.string().min(1), MustAskTopicSchema]))
        .optional(),
      /**
       * Prepared questions. Either `string[]` (legacy — flat list, ask in
       * order) or per-skill groups with follow-up / additional toggles.
       */
      questions: z
        .array(
          z.union([z.string().min(1).max(4000), InterviewQuestionGroupSchema]),
        )
        .optional(),
      /** Skill plan: skill + topics + weightage + difficulty + instructions */
      skills: z.array(z.union([z.string().min(1), InterviewSkillSpecSchema])).optional(),
      scoringRubric: z.record(z.number()).optional(),
      customFields: z.record(z.unknown()).optional(),
      /** Optional employer-specific instructions (merged on top of agent defaults) */
      instructions: z.string().optional(),
    })
    .partial()
    .optional(),
  jd: z
    .object({
      id: z.string().optional(),
      title: z.string().optional(),
      text: z.string().optional(),
      summary: z.string().optional(),
      url: z.string().optional(),
      version: z.string().optional(),
    })
    .partial()
    .optional(),
  interviewRules: z
    .object({
      forbidExternalHelp: z.boolean().optional(),
      requireCameraOn: z.boolean().optional(),
      requireScreenShare: z.boolean().optional(),
      /** Legacy single string, comma-separated, or array — merged into languagePolicy */
      languagePolicy: z.union([z.string(), z.array(z.string().min(2).max(16))]).optional(),
      antiCheatLevel: z.enum(["off", "basic", "strict"]).optional(),
    })
    .partial()
    .optional(),
  providerConfig: z
    .object({
      llm: z
        .object({
          provider: z.string().optional(),
          apiKey: z.string().optional(),
          model: z.string().optional(),
        })
        .partial()
        .optional(),
      stt: z
        .object({
          provider: z.string().optional(),
          apiKey: z.string().optional(),
          model: z.string().optional(),
          language: z.string().nullish(),
          mode: z.string().nullish(),
        })
        .partial()
        .optional(),
      tts: z
        .object({
          provider: z.string().optional(),
          apiKey: z.string().optional(),
          voice: z.string().optional(),
          model: z.string().optional(),
          targetLanguageCode: z.string().nullish(),
        })
        .partial()
        .optional(),
    })
    .partial()
    .optional(),
  vision: z
    .object({
      enabled: z.boolean().optional(),
      sampleEverySeconds: z.number().positive().max(120).optional(),
    })
    .partial()
    .optional(),
});

export const EndInterviewSessionSchema = z.object({
  reason: z.string().optional(),
});

export const ResolveInterviewSessionSchema = z.object({
  joinToken: z.string().min(1),
});

export const InterviewSessionEventSchema = z.object({
  type: z.string().min(1),
  payload: z.record(z.unknown()).default({}),
});

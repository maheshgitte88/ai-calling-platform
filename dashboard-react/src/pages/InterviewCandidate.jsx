import { useMemo, useState } from "react";
import { api } from "../services/api";

// ---------------------------------------------------------------------------
// Form shape
// ---------------------------------------------------------------------------

const DIFFICULTY_OPTIONS = ["", "easy", "medium", "hard"];
const DIFFICULTY_LABELS = {
  "": "—",
  easy: "Easy",
  medium: "Medium",
  hard: "Hard",
};

function makeSkillPlanRow() {
  return {
    skill: "",
    topics: "",
    weightage: "",
    difficulty: "",
    instructions: "",
  };
}

function makeQuestionGroupRow() {
  return {
    skill: "",
    questionsText: "",
    askFollowUps: true,
    allowAdditional: false,
    weightage: "",
  };
}

function makeMustAskTopicRow() {
  return {
    topic: "",
    askNow: false,
  };
}

const defaultForm = {
  candidateId: "",
  interviewId: "",
  candidateName: "",
  title: "",
  language: "en",
  languagePolicy: "",
  durationMinutes: 35,
  linkExpiryHours: 24,
  recordingEnabled: false,
  yearsExperience: "",
  skills: "",
  resumeSummary: "",
  jdTitle: "",
  jdText: "",
  extraInstructions: "",
  visionEnabled: false,
  skillPlan: [makeSkillPlanRow()],
  questionGroups: [makeQuestionGroupRow()],
  mustAskTopics: [makeMustAskTopicRow()],
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function splitList(value, separator = /[,;]/) {
  return String(value || "")
    .split(separator)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseWeightage(raw) {
  if (raw == null || String(raw).trim() === "") return undefined;
  const parsed = Number(String(raw).replace("%", "").trim());
  return Number.isFinite(parsed) ? parsed : undefined;
}

function buildSkillPlanPayload(rows) {
  const out = [];
  for (const row of rows) {
    const skill = row.skill.trim();
    if (!skill) continue;
    const topics = splitList(row.topics);
    const weightage = parseWeightage(row.weightage);
    const difficulty = row.difficulty || undefined;
    const instructions = row.instructions.trim() || undefined;
    out.push({
      skill,
      topics: topics.length ? topics : undefined,
      weightage,
      difficulty,
      instructions,
    });
  }
  return out;
}

function buildQuestionGroupsPayload(rows) {
  const out = [];
  for (const row of rows) {
    const skill = row.skill.trim();
    if (!skill) continue;
    const questions = splitList(row.questionsText, "\n");
    if (!questions.length) continue;
    const weightage = parseWeightage(row.weightage);
    out.push({
      skill,
      questions,
      askFollowUps: Boolean(row.askFollowUps),
      allowAdditional: Boolean(row.allowAdditional),
      weightage,
    });
  }
  return out;
}

function buildMustAskTopicsPayload(rows) {
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const topic = row.topic.trim();
    if (!topic) continue;
    const key = topic.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ topic, askNow: Boolean(row.askNow) });
  }
  return out;
}

function buildStartSessionPayload(form) {
  const yearsExperience = form.yearsExperience === "" ? undefined : Number(form.yearsExperience);
  const languagePolicy = splitList(form.languagePolicy).map((item) => item.toLowerCase());
  const candidateSkills = splitList(form.skills);
  const skillPlan = buildSkillPlanPayload(form.skillPlan);
  const questionGroups = buildQuestionGroupsPayload(form.questionGroups);
  const mustAskTopics = buildMustAskTopicsPayload(form.mustAskTopics);
  const linkExpiryHours = Number(form.linkExpiryHours);

  return {
    candidateId: form.candidateId.trim(),
    interviewId: form.interviewId.trim(),
    linkExpiryHours: Number.isFinite(linkExpiryHours) && linkExpiryHours > 0 ? linkExpiryHours : undefined,
    recordingEnabled: Boolean(form.recordingEnabled),
    candidate: {
      name: form.candidateName.trim() || undefined,
      yearsExperience: Number.isFinite(yearsExperience) ? yearsExperience : undefined,
      skills: candidateSkills.length ? candidateSkills : undefined,
      resumeSummary: form.resumeSummary.trim() || undefined,
    },
    interviewMeta: {
      title: form.title.trim() || undefined,
      language: form.language.trim() || "en",
      languagePolicy: languagePolicy.length ? languagePolicy : undefined,
      durationMinutes: Number(form.durationMinutes) || 35,
      mustAskTopics: mustAskTopics.length ? mustAskTopics : undefined,
      questions: questionGroups.length ? questionGroups : undefined,
      skills: skillPlan.length ? skillPlan : undefined,
      instructions: form.extraInstructions.trim() || undefined,
    },
    jd:
      form.jdTitle.trim() || form.jdText.trim()
        ? {
            title: form.jdTitle.trim() || undefined,
            text: form.jdText.trim() || undefined,
          }
        : undefined,
    vision: {
      enabled: Boolean(form.visionEnabled),
      sampleEverySeconds: 10,
    },
  };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function InterviewCandidate() {
  const [form, setForm] = useState(defaultForm);
  const [status, setStatus] = useState("idle");
  const [generated, setGenerated] = useState(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");

  const canGenerate = useMemo(() => {
    return form.candidateId.trim() && form.interviewId.trim() && status !== "creating";
  }, [form.candidateId, form.interviewId, status]);

  const updateForm = (patch) => {
    setForm((current) => ({ ...current, ...patch }));
    setError("");
  };

  const updateRow = (key, index, patch) => {
    setForm((current) => {
      const next = current[key].map((row, i) => (i === index ? { ...row, ...patch } : row));
      return { ...current, [key]: next };
    });
    setError("");
  };

  const addRow = (key, factory) => {
    setForm((current) => ({ ...current, [key]: [...current[key], factory()] }));
  };

  const removeRow = (key, index, factory) => {
    setForm((current) => {
      const next = current[key].filter((_, i) => i !== index);
      return { ...current, [key]: next.length ? next : [factory()] };
    });
  };

  const generateLink = async () => {
    if (!canGenerate) return;
    setStatus("creating");
    setError("");
    setCopied("");
    try {
      const response = await api.startInterviewSession(buildStartSessionPayload(form));
      setGenerated(response);
      setStatus("created");
    } catch (err) {
      setError(err?.message || "Failed to generate interview link");
      setStatus("failed");
    }
  };

  const resetForm = () => {
    setForm(defaultForm);
    setGenerated(null);
    setError("");
    setCopied("");
    setStatus("idle");
  };

  const copyValue = async (label, value) => {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    setCopied(label);
    window.setTimeout(() => setCopied(""), 1500);
  };

  return (
    <div>
      <h1 style={{ marginBottom: "0.65rem" }}>Schedule Interview</h1>
      <p style={styles.pageIntro}>
        Fill interview details and generate a secure candidate link. The candidate joins from that
        link; this page does not open the interview room.
      </p>

      <div style={styles.card}>
        <div style={styles.sectionHeader}>
          <div>
            <h2 style={styles.sectionTitle}>Candidate and interview</h2>
            <p style={styles.sectionSubtext}>Only candidateId and interviewId are required.</p>
          </div>
          <span style={styles.badge}>Link generator</span>
        </div>

        <div style={styles.grid}>
          <input
            style={styles.input}
            placeholder="candidateId"
            value={form.candidateId}
            onChange={(e) => updateForm({ candidateId: e.target.value })}
          />
          <input
            style={styles.input}
            placeholder="interviewId"
            value={form.interviewId}
            onChange={(e) => updateForm({ interviewId: e.target.value })}
          />
          <input
            style={styles.input}
            placeholder="Candidate name (optional)"
            value={form.candidateName}
            onChange={(e) => updateForm({ candidateName: e.target.value })}
          />
          <input
            style={styles.input}
            placeholder="Interview title (optional)"
            value={form.title}
            onChange={(e) => updateForm({ title: e.target.value })}
          />
          <input
            style={styles.input}
            placeholder="Primary language (e.g. en)"
            value={form.language}
            onChange={(e) => updateForm({ language: e.target.value })}
          />
          <input
            style={styles.input}
            placeholder="Language policy: en, hi, ta (optional)"
            value={form.languagePolicy}
            onChange={(e) => updateForm({ languagePolicy: e.target.value })}
          />
          <input
            style={styles.input}
            type="number"
            min={0}
            max={80}
            step="0.5"
            placeholder="Years experience (optional)"
            value={form.yearsExperience}
            onChange={(e) => updateForm({ yearsExperience: e.target.value })}
          />
          <input
            style={styles.input}
            placeholder="Candidate skills: React, Node (comma-separated)"
            value={form.skills}
            onChange={(e) => updateForm({ skills: e.target.value })}
          />
          <input
            style={styles.input}
            type="number"
            min={5}
            max={180}
            placeholder="duration (minutes)"
            value={form.durationMinutes}
            onChange={(e) => updateForm({ durationMinutes: e.target.value })}
          />
          <input
            style={styles.input}
            type="number"
            min={1}
            max={720}
            placeholder="Link expiry (hours)"
            value={form.linkExpiryHours}
            onChange={(e) => updateForm({ linkExpiryHours: e.target.value })}
          />
        </div>

        <label style={styles.labelMuted}>
          Candidate resume summary (optional, but highly recommended — the AI uses it to tailor questions and follow-ups)
        </label>
        <textarea
          style={styles.textarea}
          rows={5}
          placeholder="Paste a short narrative or the candidate's resume summary. Mention current role, key projects, tech stack, achievements."
          value={form.resumeSummary}
          onChange={(e) => updateForm({ resumeSummary: e.target.value })}
        />

        <div style={styles.gridFull}>
          <input
            style={styles.input}
            placeholder="JD title (optional)"
            value={form.jdTitle}
            onChange={(e) => updateForm({ jdTitle: e.target.value })}
          />
        </div>

        <label style={styles.labelMuted}>Job description (optional)</label>
        <textarea
          style={styles.textarea}
          rows={3}
          placeholder="Paste JD text for the AI to use as context"
          value={form.jdText}
          onChange={(e) => updateForm({ jdText: e.target.value })}
        />

        <label style={styles.labelMuted}>Extra instructions for the AI (optional, added on top of defaults)</label>
        <textarea
          style={styles.textarea}
          rows={2}
          placeholder="Example: emphasize system design; keep questions practical."
          value={form.extraInstructions}
          onChange={(e) => updateForm({ extraInstructions: e.target.value })}
        />

        <div style={styles.optionsRow}>
          <label style={styles.checkboxLabel}>
            <input
              type="checkbox"
              checked={form.visionEnabled}
              onChange={(e) => updateForm({ visionEnabled: e.target.checked })}
            />{" "}
            Enable vision sampling
          </label>
          <label style={styles.checkboxLabel}>
            <input
              type="checkbox"
              checked={form.recordingEnabled}
              onChange={(e) => updateForm({ recordingEnabled: e.target.checked })}
            />{" "}
            Record interview (Azure storage)
          </label>
        </div>
      </div>

      <MustAskTopicsSection
        rows={form.mustAskTopics}
        onChange={(index, patch) => updateRow("mustAskTopics", index, patch)}
        onAdd={() => addRow("mustAskTopics", makeMustAskTopicRow)}
        onRemove={(index) => removeRow("mustAskTopics", index, makeMustAskTopicRow)}
      />

      <SkillPlanSection
        rows={form.skillPlan}
        onChange={(index, patch) => updateRow("skillPlan", index, patch)}
        onAdd={() => addRow("skillPlan", makeSkillPlanRow)}
        onRemove={(index) => removeRow("skillPlan", index, makeSkillPlanRow)}
      />

      <QuestionGroupsSection
        rows={form.questionGroups}
        onChange={(index, patch) => updateRow("questionGroups", index, patch)}
        onAdd={() => addRow("questionGroups", makeQuestionGroupRow)}
        onRemove={(index) => removeRow("questionGroups", index, makeQuestionGroupRow)}
      />

      {error ? (
        <div style={styles.errorBox}>
          <strong>Error:</strong> {error}
        </div>
      ) : null}

      <div style={styles.row}>
        <button disabled={!canGenerate} style={styles.btnPrimary} onClick={generateLink}>
          {status === "creating" ? "Generating..." : "Generate interview link"}
        </button>
        <button disabled={status === "creating"} style={styles.btnSecondary} onClick={resetForm}>
          Clear
        </button>
      </div>

      {generated ? (
        <div style={styles.resultCard}>
          <div style={styles.sectionHeader}>
            <div>
              <h2 style={styles.sectionTitle}>Interview link generated</h2>
              <p style={styles.sectionSubtext}>
                Share this link with the candidate. Do not use this page to join the room.
              </p>
            </div>
            <span style={styles.successBadge}>Ready</span>
          </div>

          <div style={styles.resultGrid}>
            <div style={styles.resultItem}>
              <span style={styles.resultLabel}>Candidate link</span>
              <div style={styles.copyRow}>
                <input style={styles.readonlyInput} readOnly value={generated.candidateJoinUrl || ""} />
                <button
                  style={styles.btnSecondary}
                  onClick={() => copyValue("link", generated.candidateJoinUrl)}
                >
                  {copied === "link" ? "Copied" : "Copy"}
                </button>
              </div>
            </div>

            <div style={styles.resultItem}>
              <span style={styles.resultLabel}>Session ID</span>
              <code style={styles.codeBlock}>{generated.sessionId || "-"}</code>
            </div>
            <div style={styles.resultItem}>
              <span style={styles.resultLabel}>Room</span>
              <code style={styles.codeBlock}>{generated.roomName || "-"}</code>
            </div>
            <div style={styles.resultItem}>
              <span style={styles.resultLabel}>Link expires</span>
              <span>{generated.linkExpiresAt ? new Date(generated.linkExpiresAt).toLocaleString() : "-"}</span>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sections (one component per concern → easier to tweak independently)
// ---------------------------------------------------------------------------

function MustAskTopicsSection({ rows, onChange, onAdd, onRemove }) {
  return (
    <div style={styles.card}>
      <div style={styles.sectionHeader}>
        <div>
          <h2 style={styles.sectionTitle}>Must-ask topics</h2>
          <p style={styles.sectionSubtext}>
            Topics the AI must cover before wrap-up. Toggle <em>Ask now</em> to make a topic
            high priority (covered early); leave it off for normal flow.
          </p>
        </div>
        <button style={styles.btnSecondary} type="button" onClick={onAdd}>
          + Add topic
        </button>
      </div>

      <div style={styles.rowsList}>
        {rows.map((row, index) => (
          <div key={`topic-${index}`} style={styles.subRow}>
            <input
              style={{ ...styles.input, flex: 1, minWidth: 220 }}
              placeholder="Topic (e.g. System design)"
              value={row.topic}
              onChange={(e) => onChange(index, { topic: e.target.value })}
            />
            <label style={styles.checkboxLabel}>
              <input
                type="checkbox"
                checked={row.askNow}
                onChange={(e) => onChange(index, { askNow: e.target.checked })}
              />{" "}
              Ask now (high priority)
            </label>
            <button
              type="button"
              style={styles.btnDanger}
              onClick={() => onRemove(index)}
              aria-label="Remove topic"
            >
              Remove
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function SkillPlanSection({ rows, onChange, onAdd, onRemove }) {
  return (
    <div style={styles.card}>
      <div style={styles.sectionHeader}>
        <div>
          <h2 style={styles.sectionTitle}>Skill plan</h2>
          <p style={styles.sectionSubtext}>
            For each skill, set topics, weightage, difficulty (easy / medium / hard) and optional
            per-skill instructions for the AI (e.g. depth, focus areas, style).
          </p>
        </div>
        <button style={styles.btnSecondary} type="button" onClick={onAdd}>
          + Add skill
        </button>
      </div>

      <div style={styles.rowsList}>
        {rows.map((row, index) => (
          <div key={`skill-${index}`} style={styles.subCard}>
            <div style={styles.skillRowGrid}>
              <input
                style={styles.input}
                placeholder="Skill (e.g. JavaScript)"
                value={row.skill}
                onChange={(e) => onChange(index, { skill: e.target.value })}
              />
              <input
                style={styles.input}
                placeholder="Topics: closures, async, event loop"
                value={row.topics}
                onChange={(e) => onChange(index, { topics: e.target.value })}
              />
              <input
                style={styles.input}
                type="number"
                min={0}
                max={100}
                placeholder="Weightage %"
                value={row.weightage}
                onChange={(e) => onChange(index, { weightage: e.target.value })}
              />
              <select
                style={styles.input}
                value={row.difficulty}
                onChange={(e) => onChange(index, { difficulty: e.target.value })}
              >
                {DIFFICULTY_OPTIONS.map((value) => (
                  <option key={value || "none"} value={value}>
                    {value ? `Difficulty: ${DIFFICULTY_LABELS[value]}` : "Difficulty: —"}
                  </option>
                ))}
              </select>
            </div>
            <textarea
              style={styles.textarea}
              rows={2}
              placeholder='Skill-specific instructions, e.g. "Ask beginner-level questions focusing on conceptual fundamentals and high-impact practical implementations."'
              value={row.instructions}
              onChange={(e) => onChange(index, { instructions: e.target.value })}
            />
            <div style={styles.subRowActions}>
              <button
                type="button"
                style={styles.btnDanger}
                onClick={() => onRemove(index)}
                aria-label="Remove skill"
              >
                Remove skill
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function QuestionGroupsSection({ rows, onChange, onAdd, onRemove }) {
  return (
    <div style={styles.card}>
      <div style={styles.sectionHeader}>
        <div>
          <h2 style={styles.sectionTitle}>Prepared questions per skill</h2>
          <p style={styles.sectionSubtext}>
            Group the questions by skill. The per-group <em>weightage</em> is used by the
            evaluation to compute the skill-weighted overall score (the AI interviewer is not
            shown this number during the interview). Use the toggles to control whether the AI
            may probe with follow-ups, and whether it may add extra questions after the list.
          </p>
        </div>
        <button style={styles.btnSecondary} type="button" onClick={onAdd}>
          + Add skill questions
        </button>
      </div>

      <div style={styles.rowsList}>
        {rows.map((row, index) => (
          <div key={`qgroup-${index}`} style={styles.subCard}>
            <div style={{ ...styles.skillRowGrid, marginBottom: 8 }}>
              <input
                style={styles.input}
                placeholder="Skill (e.g. JavaScript)"
                value={row.skill}
                onChange={(e) => onChange(index, { skill: e.target.value })}
              />
              <input
                style={styles.input}
                type="number"
                min={0}
                max={100}
                placeholder="Weightage % (used in evaluation)"
                value={row.weightage}
                onChange={(e) => onChange(index, { weightage: e.target.value })}
              />
            </div>
            <textarea
              style={styles.textarea}
              rows={4}
              placeholder={
                "One question per line:\nWhat is the JavaScript event loop?\nDescribe a closure with a real example."
              }
              value={row.questionsText}
              onChange={(e) => onChange(index, { questionsText: e.target.value })}
            />
            <div style={styles.optionsRow}>
              <label style={styles.checkboxLabel}>
                <input
                  type="checkbox"
                  checked={row.askFollowUps}
                  onChange={(e) => onChange(index, { askFollowUps: e.target.checked })}
                />{" "}
                AI may ask follow-up questions
              </label>
              <label style={styles.checkboxLabel}>
                <input
                  type="checkbox"
                  checked={row.allowAdditional}
                  onChange={(e) => onChange(index, { allowAdditional: e.target.checked })}
                />{" "}
                Allow extra questions after the list
              </label>
            </div>
            <div style={styles.subRowActions}>
              <button
                type="button"
                style={styles.btnDanger}
                onClick={() => onRemove(index)}
                aria-label="Remove skill questions"
              >
                Remove
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = {
  pageIntro: {
    color: "#64748b",
    marginBottom: "1.2rem",
    maxWidth: 760,
    lineHeight: 1.5,
  },
  card: {
    background: "#fff",
    border: "1px solid #e2e8f0",
    borderRadius: 14,
    padding: 18,
    marginBottom: 16,
    boxShadow: "0 1px 2px rgba(15, 23, 42, 0.04)",
  },
  resultCard: {
    background: "#f8fafc",
    border: "1px solid #dbeafe",
    borderRadius: 14,
    padding: 18,
    marginBottom: 16,
  },
  sectionHeader: {
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    alignItems: "flex-start",
    marginBottom: 14,
    flexWrap: "wrap",
  },
  sectionTitle: {
    margin: 0,
    fontSize: "1rem",
    color: "#0f172a",
  },
  sectionSubtext: {
    margin: "4px 0 0",
    color: "#64748b",
    fontSize: "0.9rem",
    maxWidth: 720,
    lineHeight: 1.45,
  },
  badge: {
    border: "1px solid #cbd5e1",
    color: "#475569",
    background: "#f8fafc",
    borderRadius: 999,
    padding: "0.25rem 0.65rem",
    fontSize: "0.78rem",
    fontWeight: 700,
    whiteSpace: "nowrap",
  },
  successBadge: {
    border: "1px solid #bbf7d0",
    color: "#166534",
    background: "#f0fdf4",
    borderRadius: 999,
    padding: "0.25rem 0.65rem",
    fontSize: "0.78rem",
    fontWeight: 700,
    whiteSpace: "nowrap",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
    gap: 10,
  },
  gridFull: {
    marginTop: 10,
    display: "grid",
    gridTemplateColumns: "1fr",
    gap: 10,
  },
  labelMuted: {
    display: "block",
    marginTop: 10,
    marginBottom: 4,
    fontSize: "0.82rem",
    fontWeight: 600,
    color: "#64748b",
  },
  textarea: {
    width: "100%",
    boxSizing: "border-box",
    border: "1px solid #cbd5e1",
    borderRadius: 8,
    padding: "0.55rem 0.7rem",
    fontSize: "0.92rem",
    fontFamily: "inherit",
    resize: "vertical",
  },
  input: {
    border: "1px solid #cbd5e1",
    borderRadius: 8,
    padding: "0.55rem 0.7rem",
    fontSize: "0.92rem",
    background: "#fff",
  },
  readonlyInput: {
    flex: 1,
    minWidth: 0,
    border: "1px solid #cbd5e1",
    borderRadius: 8,
    padding: "0.55rem 0.7rem",
    fontSize: "0.9rem",
    background: "#fff",
  },
  optionsRow: {
    display: "flex",
    gap: 16,
    flexWrap: "wrap",
    marginTop: 12,
  },
  checkboxLabel: {
    color: "#334155",
    fontSize: "0.9rem",
  },
  row: {
    display: "flex",
    gap: 8,
    flexWrap: "wrap",
    marginTop: 14,
    marginBottom: 16,
  },
  btnPrimary: {
    border: "none",
    background: "#0f172a",
    color: "#fff",
    borderRadius: 8,
    padding: "0.6rem 0.9rem",
    cursor: "pointer",
    fontWeight: 700,
  },
  btnSecondary: {
    border: "1px solid #cbd5e1",
    background: "#fff",
    color: "#0f172a",
    borderRadius: 8,
    padding: "0.45rem 0.75rem",
    cursor: "pointer",
    fontSize: "0.88rem",
  },
  btnDanger: {
    border: "1px solid #fecaca",
    background: "#fff",
    color: "#b91c1c",
    borderRadius: 8,
    padding: "0.4rem 0.7rem",
    cursor: "pointer",
    fontSize: "0.85rem",
  },
  errorBox: {
    marginTop: 12,
    color: "#991b1b",
    background: "#fef2f2",
    border: "1px solid #fecaca",
    borderRadius: 8,
    padding: "0.65rem 0.8rem",
  },
  resultGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
    gap: 12,
  },
  resultItem: {
    display: "flex",
    flexDirection: "column",
    gap: 6,
    minWidth: 0,
  },
  resultLabel: {
    color: "#64748b",
    fontSize: "0.78rem",
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.06em",
  },
  copyRow: {
    display: "flex",
    gap: 8,
    minWidth: 0,
  },
  codeBlock: {
    border: "1px solid #e2e8f0",
    borderRadius: 8,
    padding: "0.55rem 0.7rem",
    background: "#fff",
    overflowWrap: "anywhere",
  },
  rowsList: {
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  subRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    flexWrap: "wrap",
  },
  subRowActions: {
    display: "flex",
    justifyContent: "flex-end",
    marginTop: 8,
  },
  subCard: {
    border: "1px solid #e2e8f0",
    borderRadius: 10,
    padding: 12,
    background: "#fafbfd",
  },
  skillRowGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
    gap: 10,
    marginBottom: 8,
  },
};

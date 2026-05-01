import { useEffect, useState } from "react";
import {
  X,
  User,
  ClipboardList,
  Activity,
  Calendar,
  Hash,
  FileJson,
} from "lucide-react";
import { api } from "../services/api";
import PoweredByHirecorrecto from "../components/PoweredByHirecorrecto";
import RecommendationPill from "../components/RecommendationPill";

export default function Interviews() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState(null);

  const load = async () => {
    const r = await api.getInterviewSessions({ limit: 200 });
    setItems(r.items || []);
  };

  useEffect(() => {
    load().finally(() => setLoading(false));
  }, []);

  const openDetail = async (sessionId) => {
    setSelectedId(sessionId);
    const d = await api.getInterviewSession(sessionId);
    setDetail(d);
  };

  const closeDetail = () => {
    setSelectedId("");
    setDetail(null);
  };

  if (loading) return <div style={{ padding: "1rem" }}>Loading...</div>;

  return (
    <div>
      <h1 style={{ marginBottom: "1rem" }}>Interviews</h1>
      <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Candidate</th>
              <th style={styles.th}>Interview</th>
              <th style={styles.th}>JD</th>
              <th style={styles.th}>Status</th>
              <th style={styles.th}>Score</th>
              <th style={styles.th}>Created</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.session_id} style={styles.tr} onClick={() => openDetail(it.session_id)}>
                <td style={styles.td}>{it.participant_name || it.candidate_id}</td>
                <td style={styles.td}>{it.metadata?.interviewMeta?.title || it.interview_id}</td>
                <td style={styles.td}>{it.metadata?.jd?.title || "-"}</td>
                <td style={styles.td}>{it.status}</td>
                <td style={styles.td}>
                  {it.latest_overall_score != null ? `${it.latest_overall_score}%` : "-"}
                </td>
                <td style={styles.td}>{new Date(it.created_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {detail && selectedId && (
        <InterviewDetailModal detail={detail} onClose={closeDetail} />
      )}
    </div>
  );
}

function InterviewDetailModal({ detail, onClose }) {
  const session = detail?.session;
  const ev = detail?.evaluation;
  const title = session?.metadata?.interviewMeta?.title || session?.interview_id || "Interview";
  const status = session?.status || "—";
  const created = session?.created_at ? new Date(session.created_at).toLocaleString() : "—";

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      style={styles.modalBackdrop}
      role="presentation"
      onClick={onClose}
    >
      <div
        style={styles.modalShell}
        role="dialog"
        aria-labelledby="interview-detail-title"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <header style={styles.modalHeader}>
          <div style={styles.modalHeaderMain}>
            <div style={styles.modalTitleRow}>
              <div style={styles.modalIconWrap}>
                <ClipboardList size={18} color="#a5b4fc" strokeWidth={2} />
              </div>
              <div>
                <h2 id="interview-detail-title" style={styles.modalH2}>
                  Interview detail
                </h2>
                <p style={styles.modalSubtitle}>{title}</p>
              </div>
            </div>
            <button type="button" style={styles.headerClose} onClick={onClose} aria-label="Close">
              <X size={18} strokeWidth={2} />
            </button>
          </div>
          <div style={styles.headerMetaRow}>
            <StatusPill status={status} />
            {ev?.overallPercent != null && (
              <span style={styles.scorePill}>{ev.overallPercent}% overall</span>
            )}
            <span style={styles.metaChip}>
              <Calendar size={14} />
              {created}
            </span>
            <span style={styles.metaChipMono}>
              <Hash size={14} />
              {session?.session_id?.slice(0, 8)}…
            </span>
          </div>
        </header>

        <div style={styles.modalBody}>
          <section style={styles.section}>
            <h3 style={styles.sectionTitle}>
              <User size={16} /> Candidate
            </h3>
            <div style={styles.gridCandidate}>
              <Field label="Candidate" value={session?.participant_name || session?.candidate_id || "—"} />
              <Field label="Interview ID" value={session?.interview_id || "—"} mono />
              <Field
                label="Rules"
                value={
                  Object.keys(session?.metadata?.interviewRules || {}).length
                    ? JSON.stringify(session.metadata.interviewRules)
                    : "—"
                }
                mono
                small
              />
            </div>
            {ev?.recommendation ? (
              <div style={styles.candidateRecommendationRow}>
                <span style={styles.recommendationKey}>Recommendation</span>
                <RecommendationPill value={ev.recommendation} />
              </div>
            ) : null}
          </section>

          {ev?.summary ? (
            <section style={styles.section}>
              <h3 style={styles.sectionTitle}>Summary</h3>
              <p style={styles.summaryText}>{ev.summary}</p>
            </section>
          ) : null}

          {(ev?.overallPercent != null || ev?.scores) ? (
            <section style={styles.section}>
              <h3 style={styles.sectionTitle}>
                <Activity size={16} /> Scores &amp; ratings
              </h3>
              {(ev?.overallPercent != null || ev?.questionStats) ? (
              <div style={styles.scoresTop}>
                {ev?.overallPercent != null ? (
                  <div style={styles.bigScore}>
                    <span style={styles.bigScoreVal}>{ev.overallPercent}%</span>
                    <span style={styles.bigScoreLbl}>Overall</span>
                  </div>
                ) : null}
                {ev?.questionStats ? (
                  <div style={styles.questionStatsBox}>
                    <div style={styles.statPair}>
                      <span style={styles.statKey}>Questions</span>
                      <span style={styles.statNum}>{ev.questionStats.total ?? 0}</span>
                    </div>
                    <div style={styles.statPair}>
                      <span style={styles.statKey}>Correct</span>
                      <span style={{ ...styles.statNum, color: "#15803d" }}>{ev.questionStats.correct ?? 0}</span>
                    </div>
                    <div style={styles.statPair}>
                      <span style={styles.statKey}>Partial</span>
                      <span style={{ ...styles.statNum, color: "#a16207" }}>{ev.questionStats.partially_correct ?? 0}</span>
                    </div>
                    <div style={styles.statPair}>
                      <span style={styles.statKey}>Incorrect</span>
                      <span style={{ ...styles.statNum, color: "#b91c1c" }}>{ev.questionStats.incorrect ?? 0}</span>
                    </div>
                    <div style={styles.statPair}>
                      <span style={styles.statKey}>Unanswered</span>
                      <span style={{ ...styles.statNum, color: "#64748b" }}>{ev.questionStats.could_not_answer ?? 0}</span>
                    </div>
                  </div>
                ) : null}
              </div>
              ) : null}
              {ev?.scores ? (
                <div style={styles.ratingsGrid}>
                  <div style={styles.ratingCell}>
                    <span style={styles.ratingLabel}>Communication</span>
                    <div style={styles.ratingScoreLine}>
                      <span style={styles.ratingValue}>{ev.scores.communication ?? "—"}</span>
                      <span style={styles.ratingScale}>/ 100</span>
                    </div>
                  </div>
                  <div style={styles.ratingCell}>
                    <span style={styles.ratingLabel}>Technical depth</span>
                    <div style={styles.ratingScoreLine}>
                      <span style={styles.ratingValue}>{ev.scores.technicalDepth ?? "—"}</span>
                      <span style={styles.ratingScale}>/ 100</span>
                    </div>
                  </div>
                  <div style={styles.ratingCell}>
                    <span style={styles.ratingLabel}>Problem solving</span>
                    <div style={styles.ratingScoreLine}>
                      <span style={styles.ratingValue}>{ev.scores.problemSolving ?? "—"}</span>
                      <span style={styles.ratingScale}>/ 100</span>
                    </div>
                  </div>
                </div>
              ) : null}
            </section>
          ) : null}

          {Array.isArray(ev?.questions) && ev.questions.length > 0 ? (
            <section style={styles.section}>
              <h3 style={styles.sectionTitle}>Questions &amp; answers</h3>
              <div style={styles.tableScroll}>
                <table style={styles.qTable}>
                  <thead>
                    <tr>
                      <th style={styles.qTh}>#</th>
                      <th style={styles.qTh}>Question</th>
                      <th style={styles.qTh}>Answer</th>
                      <th style={styles.qTh}>Verdict</th>
                      <th style={styles.qTh}>Pts</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ev.questions.map((q, idx) => (
                      <tr key={`${idx}-${q.question?.slice(0, 12)}`}>
                        <td style={styles.qTd}>{idx + 1}</td>
                        <td style={styles.qTd}>{q.question || "—"}</td>
                        <td style={styles.qTd}>{q.answer || "—"}</td>
                        <td style={styles.qTd}>
                          <VerdictBadge verdict={q.verdict} />
                        </td>
                        <td style={styles.qTd}>
                          {q.pointsEarned != null && q.pointsMax != null
                            ? `${q.pointsEarned} / ${q.pointsMax}`
                            : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          <section style={styles.section}>
            <h3 style={styles.sectionTitle}>
              <FileJson size={16} /> Events log
            </h3>
            <pre style={styles.pre}>{(detail.events || []).map((e) => `[${e.type}] ${JSON.stringify(e.payload || {})}`).join("\n")}</pre>
          </section>
        </div>

        <footer style={styles.modalFooter}>
          <div style={styles.footerLeft}>
            <span style={styles.footerHint}>Press Esc to close</span>
          </div>
          <div style={styles.footerRight}>
            <PoweredByHirecorrecto compact style={{ opacity: 0.85 }} />
            <button type="button" style={styles.footerBtnPrimary} onClick={onClose}>
              Close
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function Field({ label, value, mono, small, icon }) {
  return (
    <div style={styles.field}>
      <span style={styles.fieldLabel}>
        {icon}
        {label}
      </span>
      <span
        style={{
          ...styles.fieldValue,
          fontFamily: mono ? "ui-monospace, monospace" : "inherit",
          fontSize: small ? "0.8rem" : "0.92rem",
        }}
      >
        {value}
      </span>
    </div>
  );
}

function StatusPill({ status }) {
  const s = (status || "").toLowerCase();
  let bg = "#f1f5f9";
  let color = "#475569";
  if (s === "completed") {
    bg = "rgba(34,197,94,0.15)";
    color = "#15803d";
  } else if (s === "in_progress") {
    bg = "rgba(59,130,246,0.15)";
    color = "#1d4ed8";
  } else if (s === "waiting" || s === "dispatching") {
    bg = "rgba(234,179,8,0.15)";
    color = "#a16207";
  } else if (s === "ended") {
    bg = "rgba(100,116,139,0.2)";
    color = "#475569";
  }
  return (
    <span style={{ ...styles.statusPill, background: bg, color }}>
      {status || "—"}
    </span>
  );
}

function VerdictBadge({ verdict }) {
  const label = verdictLabel(verdict);
  const v = (verdict || "").toLowerCase();
  let bg = "#f1f5f9";
  let color = "#334155";
  if (v === "correct") {
    bg = "#dcfce7";
    color = "#166534";
  } else if (v === "partially_correct") {
    bg = "#fef9c3";
    color = "#854d0e";
  } else if (v === "incorrect") {
    bg = "#fee2e2";
    color = "#991b1b";
  } else if (v === "could_not_answer") {
    bg = "#f1f5f9";
    color = "#64748b";
  }
  return (
    <span style={{ ...styles.verdictBadge, background: bg, color }}>
      {label}
    </span>
  );
}

function verdictLabel(v) {
  const m = {
    correct: "Correct",
    partially_correct: "Partial",
    incorrect: "Incorrect",
    could_not_answer: "No answer",
  };
  return m[v] || v || "—";
}

const styles = {
  tableWrap: { background: "#fff", borderRadius: 8, border: "1px solid #e2e8f0", overflow: "auto" },
  table: { width: "100%", borderCollapse: "collapse" },
  th: { textAlign: "left", padding: "0.75rem", borderBottom: "1px solid #e2e8f0", fontWeight: 600 },
  tr: { borderBottom: "1px solid #f1f5f9", cursor: "pointer" },
  td: { padding: "0.75rem" },

  modalBackdrop: {
    position: "fixed",
    inset: 0,
    zIndex: 1000,
    background: "rgba(15,23,42,0.55)",
    backdropFilter: "blur(4px)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "clamp(12px, 3vw, 24px)",
    boxSizing: "border-box",
  },
  modalShell: {
    width: "min(920px, 100%)",
    maxHeight: "min(88vh, 900px)",
    background: "#fff",
    borderRadius: 14,
    border: "1px solid rgba(148,163,184,0.35)",
    boxShadow: "0 25px 50px -12px rgba(0,0,0,0.35)",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
  modalHeader: {
    flexShrink: 0,
    background: "linear-gradient(135deg, #0f172a 0%, #1e1b4b 55%, #312e81 100%)",
    color: "#f8fafc",
    padding: "10px 16px 8px",
    borderBottom: "1px solid rgba(255,255,255,0.08)",
  },
  modalHeaderMain: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },
  modalTitleRow: { display: "flex", alignItems: "center", gap: 14, minWidth: 0 },
  modalIconWrap: {
    width: 34,
    height: 34,
    borderRadius: 10,
    background: "rgba(255,255,255,0.1)",
    border: "1px solid rgba(255,255,255,0.15)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  modalH2: {
    margin: 0,
    fontSize: "1.05rem",
    fontWeight: 700,
    letterSpacing: "-0.02em",
    lineHeight: 1.25,
  },
  modalSubtitle: {
    margin: "2px 0 0",
    fontSize: "0.8rem",
    color: "#cbd5e1",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    maxWidth: "min(52vw, 420px)",
  },
  headerClose: {
    border: "none",
    background: "rgba(255,255,255,0.1)",
    color: "#e2e8f0",
    borderRadius: 8,
    padding: 6,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  headerMetaRow: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 8,
    marginTop: 6,
  },
  statusPill: {
    fontSize: "0.75rem",
    fontWeight: 600,
    padding: "4px 10px",
    borderRadius: 999,
    textTransform: "capitalize",
  },
  scorePill: {
    fontSize: "0.75rem",
    fontWeight: 600,
    padding: "4px 10px",
    borderRadius: 999,
    background: "rgba(167,139,250,0.25)",
    color: "#e9d5ff",
  },
  metaChip: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    fontSize: "0.78rem",
    color: "#94a3b8",
  },
  metaChipMono: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    fontSize: "0.78rem",
    color: "#64748b",
    fontFamily: "ui-monospace, monospace",
  },

  modalBody: {
    flex: 1,
    overflowY: "auto",
    padding: "14px 18px",
    background: "#f8fafc",
    minHeight: 0,
  },
  section: {
    background: "#fff",
    border: "1px solid #e2e8f0",
    borderRadius: 10,
    padding: "12px 14px",
    marginBottom: 10,
  },
  sectionTitle: {
    margin: "0 0 12px",
    fontSize: "0.82rem",
    fontWeight: 600,
    color: "#475569",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  gridCandidate: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
    gap: 12,
  },
  field: { display: "flex", flexDirection: "column", gap: 4 },
  fieldLabel: {
    fontSize: "0.72rem",
    fontWeight: 600,
    color: "#64748b",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    display: "flex",
    alignItems: "center",
    gap: 6,
  },
  fieldValue: { color: "#0f172a", lineHeight: 1.45, wordBreak: "break-word" },
  summaryText: {
    margin: 0,
    fontSize: "0.95rem",
    color: "#334155",
    lineHeight: 1.55,
  },
  scoresTop: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "stretch",
    gap: 14,
    marginBottom: 12,
  },
  bigScore: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    minWidth: 100,
    padding: "10px 16px",
    borderRadius: 10,
    background: "linear-gradient(135deg, #eef2ff, #f5f3ff)",
    border: "1px solid #e0e7ff",
    flexShrink: 0,
  },
  bigScoreVal: { fontSize: "1.35rem", fontWeight: 800, color: "#4338ca", lineHeight: 1.1 },
  bigScoreLbl: { fontSize: "0.65rem", fontWeight: 600, color: "#6366f1", textTransform: "uppercase", letterSpacing: "0.08em", marginTop: 2 },
  questionStatsBox: {
    flex: "1 1 200px",
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(76px, 1fr))",
    gap: 8,
    alignItems: "stretch",
  },
  statPair: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    textAlign: "center",
    padding: "8px 6px",
    borderRadius: 8,
    background: "#f8fafc",
    border: "1px solid #e2e8f0",
    minWidth: 0,
  },
  statKey: {
    fontSize: "0.65rem",
    fontWeight: 600,
    color: "#64748b",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
    marginBottom: 4,
    lineHeight: 1.2,
  },
  statNum: {
    fontSize: "1.1rem",
    fontWeight: 700,
    color: "#0f172a",
    lineHeight: 1.2,
  },
  ratingsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, 1fr)",
    gap: 10,
    marginTop: 4,
    paddingTop: 12,
    borderTop: "1px solid #e2e8f0",
  },
  ratingCell: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    textAlign: "center",
    padding: "8px 8px 10px",
    borderRadius: 8,
    background: "#f8fafc",
    border: "1px solid #e2e8f0",
  },
  ratingScoreLine: {
    display: "flex",
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "center",
    gap: 4,
    flexWrap: "nowrap",
    whiteSpace: "nowrap",
  },
  ratingLabel: {
    fontSize: "0.65rem",
    fontWeight: 600,
    color: "#64748b",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    marginBottom: 4,
    lineHeight: 1.2,
  },
  ratingValue: {
    fontSize: "1.2rem",
    fontWeight: 800,
    color: "#0f172a",
    lineHeight: 1,
  },
  ratingScale: {
    fontSize: "0.75rem",
    fontWeight: 600,
    color: "#94a3b8",
    lineHeight: 1,
  },
  candidateRecommendationRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    flexWrap: "wrap",
    marginTop: 14,
    paddingTop: 14,
    borderTop: "1px solid #e2e8f0",
  },
  recommendationKey: {
    fontSize: "0.72rem",
    fontWeight: 700,
    color: "#64748b",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
  },
  tableScroll: { overflowX: "auto", marginTop: 4 },
  qTable: { width: "100%", borderCollapse: "collapse", fontSize: "0.85rem" },
  qTh: {
    textAlign: "left",
    padding: "8px 10px",
    borderBottom: "1px solid #e2e8f0",
    fontWeight: 600,
    color: "#475569",
    whiteSpace: "nowrap",
  },
  qTd: { padding: "10px", borderBottom: "1px solid #f1f5f9", verticalAlign: "top", color: "#334155" },
  verdictBadge: {
    fontSize: "0.75rem",
    fontWeight: 600,
    padding: "3px 8px",
    borderRadius: 6,
    display: "inline-block",
  },
  pre: {
    background: "#0f172a",
    color: "#e2e8f0",
    padding: 12,
    borderRadius: 8,
    maxHeight: 240,
    overflow: "auto",
    fontSize: 11,
    margin: 0,
    lineHeight: 1.45,
  },

  modalFooter: {
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    flexWrap: "wrap",
    padding: "12px 20px",
    borderTop: "1px solid #e2e8f0",
    background: "#fff",
  },
  footerLeft: { minWidth: 0 },
  footerRight: { display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" },
  footerHint: { fontSize: "0.78rem", color: "#94a3b8" },
  footerBtnPrimary: {
    border: "none",
    background: "#0f172a",
    color: "#fff",
    padding: "10px 20px",
    borderRadius: 10,
    fontSize: "0.9rem",
    fontWeight: 600,
    cursor: "pointer",
  },
};

import { useEffect, useMemo, useState } from "react";
import {
  X,
  User,
  ClipboardList,
  Activity,
  Calendar,
  Hash,
  FileJson,
  Printer,
  MessageSquare,
  Sparkles,
  RefreshCcw,
  Loader2,
  Camera,
  Shield,
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
    const d = await api.getInterviewSession(sessionId, { includeProctor: true });
    setDetail(d);
  };

  const refreshDetail = async () => {
    if (!selectedId) return;
    const d = await api.getInterviewSession(selectedId, { includeProctor: true });
    setDetail(d);
    // Refresh the list too so the Score column reflects the new evaluation
    // without forcing a full page reload.
    load().catch(() => {});
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
        <InterviewDetailModal
          detail={detail}
          onClose={closeDetail}
          onRefresh={refreshDetail}
        />
      )}
    </div>
  );
}

function InterviewDetailModal({ detail, onClose, onRefresh }) {
  const session = detail?.session;
  const ev = detail?.evaluation;
  const title = session?.metadata?.interviewMeta?.title || session?.interview_id || "Interview";
  const status = session?.status || "—";
  const created = session?.created_at ? new Date(session.created_at).toLocaleString() : "—";
  const finalTranscript = useMemo(() => getFinalTranscriptLines(detail), [detail]);
  const transcriptCount = (detail?.events || []).filter((e) => e?.type === "transcript").length;
  const sessionId = session?.session_id || "";

  const [evaluating, setEvaluating] = useState(false);
  const [evalError, setEvalError] = useState("");
  const hasSummary = Boolean(ev?.summary);
  const evaluationReady = hasSummary && !evalError;
  const canEvaluate = Boolean(sessionId) && transcriptCount > 0;
  const proctorFlags = session?.proctor_latest_flags;
  const tabSwitchCount = Number(session?.proctor_tab_switch_count) || 0;

  const handleEvaluate = async () => {
    if (!sessionId || evaluating) return;
    if (hasSummary) {
      const ok = window.confirm(
        "Regenerate summary from the transcript? This will overwrite the existing evaluation.",
      );
      if (!ok) return;
    }
    setEvalError("");
    setEvaluating(true);
    try {
      await api.evaluateInterviewSession(sessionId);
      if (onRefresh) await onRefresh();
    } catch (e) {
      setEvalError(e?.message || "Could not generate summary.");
    } finally {
      setEvaluating(false);
    }
  };

  const handlePrintPdf = () => {
    const candidateName = session?.participant_name || session?.candidate_id || "Candidate";
    const recommendation = ev?.recommendation || "—";
    const summary = ev?.summary || "No summary available.";
    const rows = Array.isArray(ev?.questions)
      ? ev.questions
          .map(
            (q, idx) => `
              <tr>
                <td>${idx + 1}</td>
                <td>${escapeHtml(q?.question || "—")}</td>
                <td>${escapeHtml(q?.answer || "—")}</td>
                <td>${escapeHtml(verdictLabel(q?.verdict))}</td>
                <td>${escapeHtml(formatScore(q?.score))}</td>
              </tr>
            `,
          )
          .join("")
      : "";

    const lines = getFinalTranscriptLines(detail);
    const transcriptBlock =
      lines.length > 0
        ? lines
            .map(
              (l) =>
                `<div class="tr-line"><span class="tr-role">${escapeHtml(transcriptRoleLabel(l.role))}:</span> ${escapeHtml(l.text)}</div>`,
            )
            .join("")
        : `<p class="small">No finalized transcript lines in this session log.</p>`;

    const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Interview Result - ${escapeHtml(candidateName)}</title>
    <style>
      body { font-family: Arial, sans-serif; color: #0f172a; margin: 24px; line-height: 1.45; }
      h1 { margin: 0 0 8px; font-size: 22px; }
      h2 { margin: 18px 0 8px; font-size: 16px; }
      .meta { margin: 0 0 2px; color: #475569; font-size: 13px; }
      .pill { display: inline-block; border: 1px solid #cbd5e1; border-radius: 999px; padding: 2px 10px; font-size: 12px; margin-top: 8px; }
      table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 12px; }
      th, td { border: 1px solid #e2e8f0; padding: 8px; vertical-align: top; text-align: left; }
      th { background: #f8fafc; }
      .scores { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 8px; }
      .score-box { border: 1px solid #e2e8f0; border-radius: 8px; padding: 8px 10px; min-width: 120px; }
      .small { color: #64748b; font-size: 12px; }
      .tr-line { margin: 0 0 10px; font-size: 12px; }
      .tr-role { font-weight: 700; color: #334155; margin-right: 6px; }
    </style>
  </head>
  <body>
    <h1>Interview Result</h1>
    <p class="meta"><strong>Candidate:</strong> ${escapeHtml(candidateName)}</p>
    <p class="meta"><strong>Interview:</strong> ${escapeHtml(title)}</p>
    <p class="meta"><strong>Status:</strong> ${escapeHtml(status)}</p>
    <p class="meta"><strong>Created:</strong> ${escapeHtml(created)}</p>
    <p class="pill">Recommendation: ${escapeHtml(recommendation)}</p>

    <h2>Summary</h2>
    <p>${escapeHtml(summary)}</p>

    <h2>Scores</h2>
    <div class="scores">
      <div class="score-box"><div class="small">Overall</div><div>${ev?.overallPercent ?? "—"}%</div></div>
      <div class="score-box"><div class="small">Communication</div><div>${ev?.scores?.communication ?? "—"}</div></div>
      <div class="score-box"><div class="small">Technical depth</div><div>${ev?.scores?.technicalDepth ?? "—"}</div></div>
      <div class="score-box"><div class="small">Problem solving</div><div>${ev?.scores?.problemSolving ?? "—"}</div></div>
    </div>

    <h2>Questions & Answers</h2>
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>Question</th>
          <th>Answer</th>
          <th>Verdict</th>
          <th>Score</th>
        </tr>
      </thead>
      <tbody>
        ${rows || `<tr><td colspan="5">No question-level evaluation available.</td></tr>`}
      </tbody>
    </table>

    <h2>Final transcript</h2>
    <p class="small">Candidate lines include only finalized speech-to-text (no partials).</p>
    ${transcriptBlock}
  </body>
</html>`;

    // Hidden iframe avoids popup blockers and Chrome returning null/opaque windows when
    // window.open(..., "noopener") is used (blank tab + no document access).
    const iframe = document.createElement("iframe");
    iframe.setAttribute("title", "Interview result print");
    iframe.setAttribute("aria-hidden", "true");
    Object.assign(iframe.style, {
      position: "fixed",
      right: "0",
      bottom: "0",
      width: "0",
      height: "0",
      border: "0",
      opacity: "0",
      pointerEvents: "none",
    });
    document.body.appendChild(iframe);

    const cleanup = () => {
      if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
    };

    let printed = false;
    const runPrint = () => {
      if (printed) return;
      const win = iframe.contentWindow;
      if (!win?.document?.body) return;
      printed = true;
      try {
        win.focus();
        win.print();
      } finally {
        setTimeout(cleanup, 800);
      }
    };

    iframe.onload = () => requestAnimationFrame(() => setTimeout(runPrint, 150));
    iframe.srcdoc = html;
    window.setTimeout(runPrint, 600);
  };

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
        <style>{`@keyframes interviewsSpin { to { transform: rotate(360deg); } }`}</style>
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
            {canEvaluate ? (
              <button
                type="button"
                style={hasSummary ? styles.regenerateBtnSecondary : styles.generateBtnPrimary}
                onClick={handleEvaluate}
                disabled={evaluating}
                title={hasSummary ? "Regenerate summary from transcript" : "Generate summary from transcript"}
              >
                {evaluating ? (
                  <>
                    <Loader2 size={14} style={styles.spin} />
                    {hasSummary ? "Regenerating…" : "Generating…"}
                  </>
                ) : hasSummary ? (
                  <>
                    <RefreshCcw size={14} />
                    Regenerate summary
                  </>
                ) : (
                  <>
                    <Sparkles size={14} />
                    Generate summary
                  </>
                )}
              </button>
            ) : null}
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
          ) : (
            <section style={styles.section}>
              <h3 style={styles.sectionTitle}>Summary</h3>
              <div style={styles.evalEmptyCard}>
                <div style={styles.evalEmptyHeader}>
                  <Sparkles size={16} />
                  <strong>No summary yet for this interview.</strong>
                </div>
                <p style={styles.evalEmptyHint}>
                  {transcriptCount > 0
                    ? `We have ${transcriptCount} transcript line${
                        transcriptCount === 1 ? "" : "s"
                      } stored for this session. Click below to generate a fresh evaluation from the transcript using the same scoring pipeline as the live interview.`
                    : "No transcript was captured for this session, so a summary cannot be generated."}
                </p>
                {canEvaluate ? (
                  <button
                    type="button"
                    style={styles.generateBtnPrimary}
                    onClick={handleEvaluate}
                    disabled={evaluating}
                  >
                    {evaluating ? (
                      <>
                        <Loader2 size={14} style={styles.spin} />
                        Generating summary…
                      </>
                    ) : (
                      <>
                        <Sparkles size={14} />
                        Generate summary now
                      </>
                    )}
                  </button>
                ) : null}
              </div>
            </section>
          )}

          {evalError ? (
            <div style={styles.evalErrorBanner} role="alert">
              <strong>Could not generate summary.</strong>
              <span>{evalError}</span>
            </div>
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
                      <span style={styles.statKey}>Weak</span>
                      <span style={{ ...styles.statNum, color: "#b45309" }}>{ev.questionStats.weak ?? 0}</span>
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
                      <th style={styles.qTh}>Score</th>
                      <th style={styles.qTh}>Breakdown</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ev.questions.map((q, idx) => (
                      <tr key={`${idx}-${q.question?.slice(0, 12)}`}>
                        <td style={styles.qTd}>{idx + 1}</td>
                        <td style={styles.qTd}>{q.question || "—"}</td>
                        <td style={styles.qTd}>
                          <div>{q.answer || "—"}</div>
                          {q.rationale ? <RationaleToggle text={q.rationale} /> : null}
                        </td>
                        <td style={styles.qTd}>
                          <VerdictBadge verdict={q.verdict} />
                        </td>
                        <td style={styles.qTd}>{formatScore(q?.score)}</td>
                        <td style={styles.qTd}>
                          <BreakdownCell question={q} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}

          {evaluationReady && proctorFlags ? (
            <section style={styles.section}>
              <h3 style={styles.sectionTitle}>
                <Activity size={16} /> Proctoring signals
              </h3>
              <ProctorFlagsPanel flags={proctorFlags} tabSwitchCount={tabSwitchCount} />
            </section>
          ) : null}

          {detail?.proctorArtifacts ? (
            <section style={styles.section}>
              <h3 style={styles.sectionTitle}>
                <Shield size={16} /> Proctoring artifacts
              </h3>
              <ProctorArtifactsSection artifacts={detail.proctorArtifacts} />
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
            <button type="button" style={styles.footerBtnSecondary} onClick={handlePrintPdf}>
              <Printer size={15} />
              Print PDF
            </button>
            <button type="button" style={styles.footerBtnPrimary} onClick={onClose}>
              Close
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function formatProctorTime(value) {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
}

function ProctorArtifactsSection({ artifacts }) {
  const counts = artifacts?.frameCounts || {};
  const sessionCounts = artifacts?.sessionCounts || {};
  const identity = artifacts?.identitySnapshot;
  const audioEvents = artifacts?.precheckAudio || [];
  const tabFrames = artifacts?.tabSwitchSnapshots || [];
  const cameraFrames = artifacts?.cameraSnapshots || [];
  const identityFrames = (artifacts?.frames || []).filter((f) => f.frame_kind === "precheck_identity");

  const countEntries = Object.entries(counts);
  const hasCounts = countEntries.length > 0 || artifacts?.totalFrames != null;

  return (
    <div style={styles.proctorArtifactsWrap}>
      {hasCounts ? (
        <div style={styles.proctorCountsGrid}>
          <div style={styles.proctorCountCell}>
            <span style={styles.proctorCountKey}>Total frames</span>
            <span style={styles.proctorCountVal}>{artifacts?.totalFrames ?? 0}</span>
          </div>
          <div style={styles.proctorCountCell}>
            <span style={styles.proctorCountKey}>Tab switches</span>
            <span style={styles.proctorCountVal}>{sessionCounts.tabSwitchCount ?? 0}</span>
          </div>
          <div style={styles.proctorCountCell}>
            <span style={styles.proctorCountKey}>Not frontal (s)</span>
            <span style={styles.proctorCountVal}>{sessionCounts.notFrontalSeconds ?? 0}</span>
          </div>
          <div style={styles.proctorCountCell}>
            <span style={styles.proctorCountKey}>Eye movements</span>
            <span style={styles.proctorCountVal}>{sessionCounts.eyeMovementCount ?? 0}</span>
          </div>
          {countEntries.map(([kind, n]) => (
            <div key={kind} style={styles.proctorCountCell}>
              <span style={styles.proctorCountKey}>{kind.replace(/_/g, " ")}</span>
              <span style={styles.proctorCountVal}>{n}</span>
            </div>
          ))}
        </div>
      ) : null}

      <div style={styles.proctorArtifactBlock}>
        <h4 style={styles.proctorArtifactHeading}>
          <Camera size={14} /> Identity snapshot
        </h4>
        {identity?.blob_url ? (
          <div style={styles.proctorIdentityRow}>
            <a href={identity.blob_url} target="_blank" rel="noreferrer" style={styles.proctorThumbLink}>
              <img src={identity.blob_url} alt="Identity snapshot" style={styles.proctorThumb} />
            </a>
            <div style={styles.proctorArtifactMeta}>
              <div>
                <strong>Captured:</strong> {formatProctorTime(identity.captured_at || identity.created_at)}
              </div>
              {identity.size_bytes != null ? (
                <div>
                  <strong>Size:</strong> {Math.round(identity.size_bytes / 1024)} KB
                </div>
              ) : null}
              <a href={identity.blob_url} target="_blank" rel="noreferrer" style={styles.proctorOpenLink}>
                Open full image
              </a>
            </div>
          </div>
        ) : (
          <p style={styles.proctorMuted}>No identity snapshot stored for this session.</p>
        )}
        {identityFrames.length > 1 ? (
          <ProctorFrameTable title="All identity captures" frames={identityFrames} />
        ) : null}
      </div>

      <div style={styles.proctorArtifactBlock}>
        <h4 style={styles.proctorArtifactHeading}>Precheck audio verification</h4>
        {audioEvents.length ? (
          <ul style={styles.proctorAudioList}>
            {audioEvents.map((ev, idx) => (
              <li key={`${ev.at}-${idx}`} style={styles.proctorAudioItem}>
                <strong>Verified:</strong> {formatProctorTime(ev.at)}
                {ev.bytes != null ? ` · ${ev.bytes} bytes` : ""}
                {ev.container ? ` · ${ev.container}` : ""}
                {ev.variance != null ? ` · variance ${ev.variance}` : ""}
              </li>
            ))}
          </ul>
        ) : (
          <p style={styles.proctorMuted}>No precheck audio verification event recorded.</p>
        )}
      </div>

      {tabFrames.length ? <ProctorFrameTable title="Tab switch snapshots" frames={tabFrames} /> : null}
      {cameraFrames.length ? <ProctorFrameTable title="Camera interval snapshots" frames={cameraFrames} /> : null}
    </div>
  );
}

function ProctorFrameTable({ title, frames }) {
  if (!frames?.length) return null;
  return (
    <div style={styles.proctorArtifactBlock}>
      <h4 style={styles.proctorArtifactHeading}>{title}</h4>
      <div style={styles.tableScroll}>
        <table style={styles.qTable}>
          <thead>
            <tr>
              <th style={styles.qTh}>Preview</th>
              <th style={styles.qTh}>Captured</th>
              <th style={styles.qTh}>Kind</th>
              <th style={styles.qTh}>Link</th>
            </tr>
          </thead>
          <tbody>
            {frames.map((f) => (
              <tr key={f.id || `${f.frame_kind}-${f.captured_at}`}>
                <td style={styles.qTd}>
                  {f.blob_url ? (
                    <a href={f.blob_url} target="_blank" rel="noreferrer">
                      <img src={f.blob_url} alt="" style={styles.proctorThumbSmall} />
                    </a>
                  ) : (
                    "—"
                  )}
                </td>
                <td style={styles.qTd}>{formatProctorTime(f.captured_at || f.created_at)}</td>
                <td style={styles.qTd}>{f.frame_kind || "—"}</td>
                <td style={styles.qTd}>
                  {f.blob_url ? (
                    <a href={f.blob_url} target="_blank" rel="noreferrer" style={styles.proctorOpenLink}>
                      Open
                    </a>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ProctorFlagsPanel({ flags, tabSwitchCount }) {
  const items = [];
  if (flags?.face_present === false) items.push("Face not visible in latest frame");
  if (flags?.frontal_ok === false) items.push("Candidate not facing camera");
  if (flags?.lighting_ok === false) items.push("Lighting below threshold");
  const eyeDir = flags?.eye_direction;
  if (flags?.eye_warning === true) {
    items.push(
      `Eyes away from screen (${eyeDir || "off-center"}, ${flags?.eye_sustained_seconds ?? "?"}s)`,
    );
  } else if (
    eyeDir &&
    !["center", "unknown", "head_not_frontal"].includes(String(eyeDir))
  ) {
    items.push(`Eyes away from screen (${eyeDir})`);
  }
  if (flags?.reading_pattern_warning === true) {
    const secs = flags?.reading_pattern_offscreen_seconds_window;
    items.push(
      `Reading pattern: looked away ${secs != null ? `${secs}s` : "over 9s"} in the last 20s`,
    );
  }
  if (tabSwitchCount > 0) {
    items.push(`Tab switches detected: ${tabSwitchCount}`);
  }
  if (!items.length) {
    return (
      <p style={styles.proctorOkText}>
        No significant proctoring concerns in the latest captured signals.
      </p>
    );
  }
  return (
    <ul style={styles.proctorFlagList}>
      {items.map((text) => (
        <li key={text} style={styles.proctorFlagItem}>
          {text}
        </li>
      ))}
    </ul>
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
  let dot = "#94a3b8";
  if (v === "correct") {
    bg = "#dcfce7";
    color = "#166534";
    dot = "#16a34a";
  } else if (v === "partially_correct") {
    bg = "#fef9c3";
    color = "#854d0e";
    dot = "#ca8a04";
  } else if (v === "weak") {
    bg = "#ffedd5";
    color = "#9a3412";
    dot = "#f59e0b";
  } else if (v === "incorrect") {
    bg = "#fee2e2";
    color = "#991b1b";
    dot = "#dc2626";
  } else if (v === "could_not_answer") {
    bg = "#f1f5f9";
    color = "#64748b";
    dot = "#94a3b8";
  }
  return (
    <span style={{ ...styles.verdictBadge, background: bg, color }}>
      <span style={{ ...styles.verdictDot, background: dot }} />
      {label}
    </span>
  );
}

function formatScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "—";
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function hasAxisScores(q) {
  return (
    q != null
    && Number.isFinite(Number(q.accuracy))
    && Number.isFinite(Number(q.depth))
    && Number.isFinite(Number(q.practical))
  );
}

function BreakdownCell({ question }) {
  if (!hasAxisScores(question)) return "—";
  return (
    <span style={styles.breakdown}>
      <span>A:{question.accuracy}</span>
      <span>D:{question.depth}</span>
      <span>P:{question.practical}</span>
    </span>
  );
}

function RationaleToggle({ text }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={styles.rationaleWrap}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={styles.rationaleToggle}
        aria-expanded={open}
      >
        {open ? "▾" : "▸"} Rationale
      </button>
      {open ? <div style={styles.rationaleText}>{text}</div> : null}
    </div>
  );
}

function verdictLabel(v) {
  const m = {
    correct: "Correct",
    partially_correct: "Partial",
    weak: "Weak",
    incorrect: "Incorrect",
    could_not_answer: "No answer",
  };
  return m[v] || v || "—";
}

/** Final lines only: user must have is_final; assistant/agent lines are always kept. */
function getFinalTranscriptLines(detail) {
  const events = detail?.events || [];
  return events
    .filter((e) => e?.type === "transcript" && e.payload && typeof e.payload.text === "string")
    .filter((e) => {
      const p = e.payload;
      const role = String(p.role || "").toLowerCase();
      if (role === "assistant" || role === "agent") return true;
      if (role === "user") return p.is_final === true;
      return Boolean(p.is_final);
    })
    .map((e) => ({
      role: e.payload.role,
      text: String(e.payload.text || "").trim(),
      created_at: e.payload.created_at || e.created_at,
    }))
    .filter((l) => l.text.length > 0);
}

function transcriptRoleLabel(role) {
  const r = String(role || "").toLowerCase();
  if (r === "user") return "Candidate";
  if (r === "assistant" || r === "agent") return "Interviewer";
  return role || "Speaker";
}

function escapeHtml(input) {
  return String(input ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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
  generateBtnPrimary: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "5px 12px",
    fontSize: "0.78rem",
    fontWeight: 600,
    color: "#ffffff",
    background: "linear-gradient(135deg,#6366f1,#8b5cf6)",
    border: "none",
    borderRadius: 999,
    cursor: "pointer",
    boxShadow: "0 1px 2px rgba(99,102,241,0.35)",
  },
  regenerateBtnSecondary: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "5px 10px",
    fontSize: "0.75rem",
    fontWeight: 600,
    color: "#cbd5e1",
    background: "rgba(148,163,184,0.18)",
    border: "1px solid rgba(148,163,184,0.35)",
    borderRadius: 999,
    cursor: "pointer",
  },
  spin: {
    animation: "interviewsSpin 0.9s linear infinite",
  },
  evalEmptyCard: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
    padding: "12px 14px",
    background: "rgba(99,102,241,0.06)",
    border: "1px dashed rgba(99,102,241,0.35)",
    borderRadius: 10,
  },
  evalEmptyHeader: {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    color: "#4338ca",
    fontSize: "0.92rem",
  },
  evalEmptyHint: {
    margin: 0,
    color: "#475569",
    fontSize: "0.86rem",
    lineHeight: 1.5,
  },
  evalErrorBanner: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    margin: "0 0 12px",
    padding: "10px 12px",
    background: "rgba(220,38,38,0.08)",
    border: "1px solid rgba(220,38,38,0.35)",
    borderRadius: 8,
    color: "#991b1b",
    fontSize: "0.85rem",
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
  transcriptHint: {
    margin: "0 0 10px",
    fontSize: "0.78rem",
    color: "#64748b",
    lineHeight: 1.45,
  },
  transcriptBox: {
    maxHeight: 280,
    overflowY: "auto",
    border: "1px solid #e2e8f0",
    borderRadius: 8,
    padding: "10px 12px",
    background: "#f8fafc",
  },
  transcriptLine: {
    marginBottom: 10,
    fontSize: "0.88rem",
    lineHeight: 1.45,
    color: "#334155",
  },
  transcriptRole: {
    fontWeight: 700,
    color: "#475569",
    marginRight: 8,
  },
  transcriptText: { wordBreak: "break-word" },
  transcriptEmpty: {
    margin: 0,
    fontSize: "0.88rem",
    color: "#94a3b8",
    fontStyle: "italic",
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
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    whiteSpace: "nowrap",
  },
  verdictDot: {
    width: 7,
    height: 7,
    borderRadius: 999,
    display: "inline-block",
  },
  breakdown: {
    display: "inline-flex",
    gap: 8,
    fontFamily:
      "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
    fontSize: "0.78rem",
    color: "#64748b",
  },
  rationaleWrap: {
    marginTop: 6,
  },
  rationaleToggle: {
    background: "transparent",
    border: "none",
    padding: 0,
    color: "#475569",
    fontSize: "0.78rem",
    fontWeight: 600,
    cursor: "pointer",
  },
  rationaleText: {
    marginTop: 4,
    marginLeft: 14,
    color: "#475569",
    fontStyle: "italic",
    fontSize: "0.82rem",
    lineHeight: 1.45,
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
  proctorOkText: {
    margin: 0,
    color: "#15803d",
    fontSize: "0.9rem",
    lineHeight: 1.5,
  },
  proctorFlagList: {
    margin: 0,
    paddingLeft: 20,
    color: "#b45309",
    fontSize: "0.9rem",
    lineHeight: 1.55,
  },
  proctorFlagItem: {
    marginBottom: 6,
  },
  proctorArtifactsWrap: {
    display: "flex",
    flexDirection: "column",
    gap: 16,
  },
  proctorCountsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
    gap: 10,
  },
  proctorCountCell: {
    padding: "10px 12px",
    borderRadius: 8,
    background: "#f8fafc",
    border: "1px solid #e2e8f0",
  },
  proctorCountKey: {
    display: "block",
    fontSize: "0.72rem",
    fontWeight: 600,
    color: "#64748b",
    textTransform: "capitalize",
    marginBottom: 4,
  },
  proctorCountVal: {
    fontSize: "1.1rem",
    fontWeight: 700,
    color: "#0f172a",
  },
  proctorArtifactBlock: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  proctorArtifactHeading: {
    margin: 0,
    fontSize: "0.88rem",
    fontWeight: 700,
    color: "#334155",
    display: "flex",
    alignItems: "center",
    gap: 6,
  },
  proctorIdentityRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: 14,
    alignItems: "flex-start",
  },
  proctorThumbLink: {
    display: "block",
    borderRadius: 8,
    overflow: "hidden",
    border: "1px solid #e2e8f0",
  },
  proctorThumb: {
    display: "block",
    width: 120,
    height: "auto",
    maxHeight: 120,
    objectFit: "cover",
  },
  proctorThumbSmall: {
    display: "block",
    width: 64,
    height: 48,
    objectFit: "cover",
    borderRadius: 4,
    border: "1px solid #e2e8f0",
  },
  proctorArtifactMeta: {
    fontSize: "0.86rem",
    color: "#475569",
    lineHeight: 1.5,
    display: "flex",
    flexDirection: "column",
    gap: 6,
  },
  proctorOpenLink: {
    color: "#4f46e5",
    fontWeight: 600,
    fontSize: "0.84rem",
    textDecoration: "none",
  },
  proctorMuted: {
    margin: 0,
    color: "#64748b",
    fontSize: "0.86rem",
  },
  proctorAudioList: {
    margin: 0,
    paddingLeft: 20,
    color: "#475569",
    fontSize: "0.86rem",
    lineHeight: 1.5,
  },
  proctorAudioItem: {
    marginBottom: 6,
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
  footerBtnSecondary: {
    border: "1px solid #cbd5e1",
    background: "#fff",
    color: "#0f172a",
    padding: "9px 14px",
    borderRadius: 10,
    fontSize: "0.86rem",
    fontWeight: 600,
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    gap: 7,
  },
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

import { useEffect, useMemo, useReducer } from "react";
import {
  LiveKitRoom,
  RoomAudioRenderer,
  VideoConference,
  useRoomContext,
} from "@livekit/components-react";
import { RoomEvent } from "livekit-client";
import { api } from "../services/api";
import PoweredByHirecorrecto from "../components/PoweredByHirecorrecto";
import RecommendationPill from "../components/RecommendationPill";

const initialState = {
  phase: "idle",
  session: null,
  interviewForm: {
    candidateId: "",
    interviewId: "",
    candidateName: "",
    title: "",
    language: "en",
    languagePolicy: "",
    durationMinutes: 35,
    yearsExperience: "",
    skills: "",
    jdTitle: "",
    jdText: "",
    questionsText: "",
    extraInstructions: "",
    visionEnabled: false,
  },
  connection: { state: "disconnected", reconnectAttempts: 0, lastError: "" },
  agent: {
    present: false,
    identity: "",
    state: "connecting",
    canListen: false,
    isFinished: false,
  },
  interview: {
    startedAt: null,
    transcript: [],
    evaluation: null,
  },
};

function reducer(state, action) {
  switch (action.type) {
    case "update_form":
      return { ...state, interviewForm: { ...state.interviewForm, ...action.payload } };
    case "phase":
      return { ...state, phase: action.value };
    case "session_created":
      return { ...state, session: action.payload, phase: "connecting_room", connection: { ...state.connection, lastError: "" } };
    case "connection":
      return { ...state, connection: { ...state.connection, ...action.payload } };
    case "agent_presence":
      return {
        ...state,
        agent: {
          ...state.agent,
          present: action.present,
          identity: action.identity || "",
        },
      };
    case "agent_state":
      return {
        ...state,
        agent: {
          ...state.agent,
          state: action.stateValue,
          canListen: action.canListen,
          isFinished: action.isFinished,
        },
      };
    case "interview_started":
      return { ...state, interview: { ...state.interview, startedAt: new Date().toISOString() } };
    case "append_transcript":
      return { ...state, interview: { ...state.interview, transcript: [...state.interview.transcript, action.payload] } };
    case "evaluation":
      return { ...state, interview: { ...state.interview, evaluation: action.payload } };
    case "reset":
      return initialState;
    default:
      return state;
  }
}

function safeJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function deriveAgentState(rawState, connected) {
  const stateValue = rawState || (connected ? "initializing" : "connecting");
  const canListen = ["pre-connect-buffering", "listening", "thinking", "speaking"].includes(stateValue);
  const isFinished = ["disconnected", "failed"].includes(stateValue);
  return { stateValue, canListen, isFinished };
}

export default function InterviewCandidate() {
  const [state, dispatch] = useReducer(reducer, initialState);

  const canStart = useMemo(() => {
    return state.interviewForm.candidateId.trim() && state.interviewForm.interviewId.trim();
  }, [state.interviewForm.candidateId, state.interviewForm.interviewId]);

  const startSession = async () => {
    if (!canStart || state.phase !== "idle") return;
    dispatch({ type: "phase", value: "creating_session" });
    try {
      const langPol = state.interviewForm.languagePolicy
        .split(/[,;]/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      const preparedQs = state.interviewForm.questionsText
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      const skillList = state.interviewForm.skills
        .split(/[,;]/)
        .map((s) => s.trim())
        .filter(Boolean);
      const yeRaw = state.interviewForm.yearsExperience;
      const yearsExp =
        yeRaw === "" || yeRaw == null ? undefined : Number(yeRaw);

      const resp = await api.startInterviewSession({
        candidateId: state.interviewForm.candidateId.trim(),
        interviewId: state.interviewForm.interviewId.trim(),
        candidate: {
          name: state.interviewForm.candidateName || undefined,
          yearsExperience: Number.isFinite(yearsExp) ? yearsExp : undefined,
          skills: skillList.length ? skillList : undefined,
        },
        interviewMeta: {
          title: state.interviewForm.title || undefined,
          language: state.interviewForm.language || "en",
          languagePolicy: langPol.length ? langPol : undefined,
          durationMinutes: Number(state.interviewForm.durationMinutes) || 35,
          questions: preparedQs.length ? preparedQs : undefined,
          instructions: state.interviewForm.extraInstructions?.trim() || undefined,
        },
        jd:
          state.interviewForm.jdTitle?.trim() || state.interviewForm.jdText?.trim()
            ? {
                title: state.interviewForm.jdTitle?.trim() || undefined,
                text: state.interviewForm.jdText?.trim() || undefined,
              }
            : undefined,
        vision: {
          enabled: state.interviewForm.visionEnabled,
          sampleEverySeconds: 10,
        },
      });
      dispatch({ type: "session_created", payload: resp });
      dispatch({ type: "phase", value: "waiting_for_agent" });
    } catch (e) {
      dispatch({ type: "connection", payload: { lastError: e.message || "Failed to start session" } });
      dispatch({ type: "phase", value: "failed" });
    }
  };

  const endSession = async () => {
    if (!state.session) return;
    dispatch({ type: "phase", value: "ending" });
    try {
      await api.endInterviewSession(state.session.sessionId, { reason: "candidate_ended" });
      dispatch({ type: "phase", value: "completed" });
    } catch (e) {
      dispatch({ type: "connection", payload: { lastError: e.message || "Failed to end session" } });
      dispatch({ type: "phase", value: "failed" });
    }
  };

  useEffect(() => {
    if (!state.session?.sessionId) return undefined;
    if (state.phase === "idle") return undefined;
    let cancelled = false;
    const timer = setInterval(async () => {
      try {
        const data = await api.getInterviewSession(state.session.sessionId);
        if (cancelled) return;

        if (data?.evaluation) {
          dispatch({ type: "evaluation", payload: data.evaluation });
          if (state.phase !== "completed") dispatch({ type: "phase", value: "completed" });
          clearInterval(timer);
        }
      } catch {
        // ignore intermittent polling errors
      }
    }, 4000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [state.session?.sessionId, state.phase]);

  return (
    <div>
      <h1 style={{ marginBottom: "1rem" }}>Candidate Interview</h1>
      <p style={{ color: "#64748b", marginBottom: "1.2rem" }}>
        Candidate joins LiveKit room, backend dispatches AI interviewer, and reducer-managed session state drives UI.
      </p>

      <div style={styles.card}>
        <div style={styles.grid}>
          <input
            style={styles.input}
            placeholder="candidateId"
            value={state.interviewForm.candidateId}
            onChange={(e) => dispatch({ type: "update_form", payload: { candidateId: e.target.value } })}
          />
          <input
            style={styles.input}
            placeholder="interviewId"
            value={state.interviewForm.interviewId}
            onChange={(e) => dispatch({ type: "update_form", payload: { interviewId: e.target.value } })}
          />
          <input
            style={styles.input}
            placeholder="Candidate name (optional)"
            value={state.interviewForm.candidateName}
            onChange={(e) => dispatch({ type: "update_form", payload: { candidateName: e.target.value } })}
          />
          <input
            style={styles.input}
            placeholder="Interview title (optional)"
            value={state.interviewForm.title}
            onChange={(e) => dispatch({ type: "update_form", payload: { title: e.target.value } })}
          />
          <input
            style={styles.input}
            placeholder="Primary language (e.g. en)"
            value={state.interviewForm.language}
            onChange={(e) => dispatch({ type: "update_form", payload: { language: e.target.value } })}
          />
          <input
            style={styles.input}
            placeholder="Language policy: en, hi, ta (optional)"
            value={state.interviewForm.languagePolicy}
            onChange={(e) => dispatch({ type: "update_form", payload: { languagePolicy: e.target.value } })}
          />
          <input
            style={styles.input}
            type="number"
            min={0}
            max={80}
            step="0.5"
            placeholder="Years experience (optional)"
            value={state.interviewForm.yearsExperience}
            onChange={(e) => dispatch({ type: "update_form", payload: { yearsExperience: e.target.value } })}
          />
          <input
            style={styles.input}
            placeholder="Skills: React, Node, … (comma-separated)"
            value={state.interviewForm.skills}
            onChange={(e) => dispatch({ type: "update_form", payload: { skills: e.target.value } })}
          />
          <input
            style={styles.input}
            type="number"
            min={5}
            max={180}
            placeholder="duration (minutes)"
            value={state.interviewForm.durationMinutes}
            onChange={(e) => dispatch({ type: "update_form", payload: { durationMinutes: e.target.value } })}
          />
        </div>
        <div style={styles.gridFull}>
          <input
            style={styles.input}
            placeholder="JD title (optional)"
            value={state.interviewForm.jdTitle}
            onChange={(e) => dispatch({ type: "update_form", payload: { jdTitle: e.target.value } })}
          />
        </div>
        <label style={styles.labelMuted}>Job description (optional)</label>
        <textarea
          style={styles.textarea}
          rows={3}
          placeholder="Paste JD text for the AI to use as context…"
          value={state.interviewForm.jdText}
          onChange={(e) => dispatch({ type: "update_form", payload: { jdText: e.target.value } })}
        />
        <label style={styles.labelMuted}>Prepared questions (one per line, optional)</label>
        <textarea
          style={styles.textarea}
          rows={5}
          placeholder="What is your experience with…&#10;Describe a time when…"
          value={state.interviewForm.questionsText}
          onChange={(e) => dispatch({ type: "update_form", payload: { questionsText: e.target.value } })}
        />
        <label style={styles.labelMuted}>Extra instructions for the AI (optional, added on top of defaults)</label>
        <textarea
          style={styles.textarea}
          rows={2}
          placeholder="e.g. Emphasize system design; allow code discussion in English only."
          value={state.interviewForm.extraInstructions}
          onChange={(e) => dispatch({ type: "update_form", payload: { extraInstructions: e.target.value } })}
        />
        <label style={{ display: "block", marginTop: 8 }}>
          <input
            type="checkbox"
            checked={state.interviewForm.visionEnabled}
            onChange={(e) => dispatch({ type: "update_form", payload: { visionEnabled: e.target.checked } })}
          />{" "}
          Enable vision sampling
        </label>
        <div style={styles.row}>
          <button disabled={!canStart || state.phase !== "idle"} style={styles.btnPrimary} onClick={startSession}>
            Start interview
          </button>
          <button disabled={!state.session || ["ending", "completed"].includes(state.phase)} style={styles.btnSecondary} onClick={endSession}>
            End interview
          </button>
        </div>
      </div>

      {state.session ? (
        <LiveKitRoom
          token={state.session.token}
          serverUrl={state.session.wsUrl}
          connect={state.phase !== "completed" && state.phase !== "ending"}
          audio
          video
          onConnected={() => {
            dispatch({ type: "connection", payload: { state: "connected", lastError: "" } });
            dispatch({ type: "phase", value: "preflight" });
          }}
          onDisconnected={() => {
            if (state.phase !== "completed") {
              dispatch({ type: "connection", payload: { state: "disconnected" } });
            }
          }}
          onError={(error) => {
            dispatch({ type: "connection", payload: { lastError: error?.message || "Room error" } });
            dispatch({ type: "phase", value: "failed" });
          }}
          data-lk-theme="default"
          style={styles.lkRoom}
        >
          <InterviewRoomBridge
            session={state.session}
            phase={state.phase}
            onAgentPresence={(present, identity) => dispatch({ type: "agent_presence", present, identity })}
            onAgentState={(nextState) => dispatch({ type: "agent_state", ...nextState })}
            onPhase={(value) => dispatch({ type: "phase", value })}
            onInterviewStarted={() => dispatch({ type: "interview_started" })}
            onTranscript={(line) => dispatch({ type: "append_transcript", payload: line })}
          />
          <VideoConference />
          <RoomAudioRenderer />
        </LiveKitRoom>
      ) : null}

      <div style={styles.statusCard}>
        <p><strong>Phase:</strong> {state.phase}</p>
        <p><strong>Connection:</strong> {state.connection.state}</p>
        <p><strong>Agent:</strong> {state.agent.present ? `Connected (${state.agent.identity})` : "Waiting"}</p>
        <p><strong>Agent state:</strong> {state.agent.state}</p>
        <p><strong>Agent canListen:</strong> {String(state.agent.canListen)}</p>
        {state.session?.roomName ? <p><strong>Room:</strong> {state.session.roomName}</p> : null}
        {state.connection.lastError ? <p style={{ color: "#b91c1c" }}><strong>Error:</strong> {state.connection.lastError}</p> : null}
      </div>

      <div style={styles.card}>
        <h3>Transcript (data channel)</h3>
        {state.interview.transcript.length === 0 ? (
          <p style={{ color: "#64748b" }}>No transcript messages yet.</p>
        ) : (
          <div style={styles.transcript}>
            {state.interview.transcript.map((line, idx) => (
              <div key={`${line.createdAt}-${idx}`} style={styles.transcriptLine}>
                <strong>{line.role}:</strong> {line.text}
              </div>
            ))}
          </div>
        )}
      </div>

      {state.interview.evaluation ? (
        <div style={styles.card}>
          <h3>Interview Summary</h3>
          <p><strong>Summary:</strong> {state.interview.evaluation.summary || "-"}</p>
          {state.interview.evaluation.overallPercent != null ? (
            <p>
              <strong>Overall score:</strong> {state.interview.evaluation.overallPercent}%
              {state.interview.evaluation.questionStats ? (
                <span style={{ color: "#64748b", marginLeft: 8 }}>
                  ({state.interview.evaluation.questionStats.correct ?? 0} correct,{" "}
                  {state.interview.evaluation.questionStats.partially_correct ?? 0} partial,{" "}
                  {state.interview.evaluation.questionStats.incorrect ?? 0} incorrect,{" "}
                  {state.interview.evaluation.questionStats.could_not_answer ?? 0} unanswered of{" "}
                  {state.interview.evaluation.questionStats.total ?? 0} questions)
                </span>
              ) : null}
            </p>
          ) : null}
          {state.interview.evaluation.scores ? (
            <p>
              <strong>Ratings (0–100):</strong> communication {state.interview.evaluation.scores.communication ?? "—"},{" "}
              technical depth {state.interview.evaluation.scores.technicalDepth ?? "—"},{" "}
              problem solving {state.interview.evaluation.scores.problemSolving ?? "—"}
            </p>
          ) : null}
          {state.interview.evaluation.recommendation ? (
            <div style={styles.evalRecommendationRow}>
              <span style={styles.evalRecommendationKey}>Recommendation</span>
              <RecommendationPill value={state.interview.evaluation.recommendation} />
            </div>
          ) : null}
          {Array.isArray(state.interview.evaluation.questions) && state.interview.evaluation.questions.length > 0 ? (
            <div style={{ marginTop: 12 }}>
              <h4 style={{ margin: "0 0 8px" }}>Questions &amp; answers</h4>
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
                  {state.interview.evaluation.questions.map((q, idx) => (
                    <tr key={`${idx}-eval-q`}>
                      <td style={styles.qTd}>{idx + 1}</td>
                      <td style={styles.qTd}>{q.question || "—"}</td>
                      <td style={styles.qTd}>{q.answer || "—"}</td>
                      <td style={styles.qTd}>{evalVerdictLabel(q.verdict)}</td>
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
          ) : null}
        </div>
      ) : null}

      <div style={{ marginTop: 32, paddingTop: 20, borderTop: "1px solid #e2e8f0" }}>
        <PoweredByHirecorrecto />
      </div>
    </div>
  );
}

function evalVerdictLabel(v) {
  const m = {
    correct: "Correct",
    partially_correct: "Partially correct",
    incorrect: "Incorrect",
    could_not_answer: "Could not answer",
  };
  return m[v] || v || "—";
}

function InterviewRoomBridge({
  session,
  phase,
  onAgentPresence,
  onAgentState,
  onPhase,
  onInterviewStarted,
  onTranscript,
}) {
  const room = useRoomContext();

  useEffect(() => {
    if (!room) return undefined;
    const onParticipantConnected = (participant) => {
      if (participant.identity !== session.participantIdentity) {
        onAgentPresence(true, participant.identity);
        onAgentState(deriveAgentState(participant.attributes?.["lk.agent.state"], true));
        onPhase("interview_active");
        onInterviewStarted();
      }
    };
    const onParticipantAttributesChanged = (changedAttributes, participant) => {
      if (!participant || participant.identity === session.participantIdentity) return;
      if (!Object.prototype.hasOwnProperty.call(changedAttributes, "lk.agent.state")) return;
      onAgentState(deriveAgentState(changedAttributes["lk.agent.state"], true));
    };
    const onParticipantDisconnected = (participant) => {
      if (participant.identity === session.participantIdentity) return;
      onAgentPresence(false, "");
      onAgentState({ stateValue: "disconnected", canListen: false, isFinished: true });
      if (phase !== "completed") onPhase("ending");
    };
    const onDataReceived = (payload, participant) => {
      const msg = safeJson(new TextDecoder().decode(payload));
      if (!msg || msg.type !== "transcript") return;
      onTranscript({
        role: msg.role || (participant?.identity || "agent"),
        text: msg.text || "",
        createdAt: new Date().toISOString(),
      });
    };

    room.on(RoomEvent.ParticipantConnected, onParticipantConnected);
    room.on(RoomEvent.ParticipantAttributesChanged, onParticipantAttributesChanged);
    room.on(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
    room.on(RoomEvent.DataReceived, onDataReceived);

    return () => {
      room.off(RoomEvent.ParticipantConnected, onParticipantConnected);
      room.off(RoomEvent.ParticipantAttributesChanged, onParticipantAttributesChanged);
      room.off(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
      room.off(RoomEvent.DataReceived, onDataReceived);
    };
  }, [room, session.participantIdentity, phase, onAgentPresence, onAgentState, onPhase, onInterviewStarted, onTranscript]);

  return null;
}

const styles = {
  card: {
    background: "#fff",
    border: "1px solid #e2e8f0",
    borderRadius: 10,
    padding: 16,
    marginBottom: 16,
  },
  statusCard: {
    background: "#f8fafc",
    border: "1px solid #e2e8f0",
    borderRadius: 10,
    padding: 16,
    marginBottom: 16,
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
  },
  row: {
    display: "flex",
    gap: 8,
    flexWrap: "wrap",
    marginTop: 12,
  },
  btnPrimary: {
    border: "none",
    background: "#0f172a",
    color: "#fff",
    borderRadius: 8,
    padding: "0.55rem 0.85rem",
    cursor: "pointer",
  },
  btnSecondary: {
    border: "1px solid #cbd5e1",
    background: "#fff",
    color: "#0f172a",
    borderRadius: 8,
    padding: "0.55rem 0.85rem",
    cursor: "pointer",
  },
  transcript: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    maxHeight: 260,
    overflowY: "auto",
    borderTop: "1px solid #e2e8f0",
    marginTop: 8,
    paddingTop: 8,
  },
  transcriptLine: {
    fontSize: "0.92rem",
    lineHeight: 1.4,
  },
  lkRoom: {
    background: "#0b1220",
    borderRadius: 12,
    overflow: "hidden",
    marginBottom: 16,
    minHeight: 520,
  },
  qTable: { width: "100%", borderCollapse: "collapse", fontSize: "0.88rem", marginTop: 8 },
  qTh: { textAlign: "left", padding: "0.5rem", borderBottom: "1px solid #e2e8f0", fontWeight: 600 },
  qTd: { padding: "0.5rem", borderBottom: "1px solid #f1f5f9", verticalAlign: "top" },
  evalRecommendationRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    flexWrap: "wrap",
    marginTop: 12,
    paddingTop: 12,
    borderTop: "1px solid #e2e8f0",
  },
  evalRecommendationKey: {
    fontSize: "0.72rem",
    fontWeight: 700,
    color: "#64748b",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
  },
};


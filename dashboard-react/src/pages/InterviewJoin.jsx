import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  LiveKitRoom,
  ParticipantTile,
  RoomAudioRenderer,
  useConnectionState,
  useRoomContext,
  useTracks,
  useVoiceAssistant,
} from "@livekit/components-react";
import { ConnectionState, ParticipantKind, Track } from "livekit-client";
import {
  AlertCircle,
  Camera,
  CameraOff,
  CheckCircle2,
  Mic,
  MicOff,
  Loader2,
  RefreshCw,
  ScreenShare,
  ScreenShareOff,
  Sparkles,
  Video,
  LogOut,
  Info,
} from "lucide-react";
import { api } from "../services/api";
import PoweredByHirecorrecto from "../components/PoweredByHirecorrecto";
import AIVoiceBoatIndicator from "../components/AIVoiceBoatIndicator";

const SESSION_POLL_INTERVAL_MS = 60000;

function useJoinToken() {
  return useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("token") || "";
  }, []);
}

function mapResolveError(err) {
  const msg = err?.message || String(err || "Something went wrong.");
  const lower = msg.toLowerCase();
  if (lower.includes("already completed")) {
    return {
      title: "Interview already completed",
      message:
        "This interview session was finished. If you need another attempt, ask your recruiter to send a new link.",
      variant: "info",
      canRetry: false,
    };
  }
  if (lower.includes("already ended")) {
    return {
      title: "Interview has ended",
      message: "This session is no longer active. Contact support if you still need access.",
      variant: "info",
      canRetry: false,
    };
  }
  if (lower.includes("not found") || lower.includes("join token")) {
    return {
      title: "Link invalid or expired",
      message: "Open the interview link from your invitation again, or request a new link.",
      variant: "warn",
      canRetry: true,
    };
  }
  if (lower.includes("being prepared") || lower.includes("retry")) {
    return {
      title: "Almost ready",
      message: "The interview room is still opening. Try again in a moment.",
      variant: "neutral",
      canRetry: true,
    };
  }
  return {
    title: "Unable to join interview",
    message: msg,
    variant: "error",
    canRetry: true,
  };
}

export default function InterviewJoin() {
  const joinToken = useJoinToken();
  /** resolve_loading | error | room_connecting | live | completed */
  const [phase, setPhase] = useState(() => (joinToken ? "resolve_loading" : "error"));
  const [resolved, setResolved] = useState(null);
  const [errorInfo, setErrorInfo] = useState(() =>
    joinToken ? null : mapResolveError(new Error("Missing interview link token."))
  );
  const [completion, setCompletion] = useState(null);
  const [leaving, setLeaving] = useState(false);
  const pollRef = useRef(null);

  const clearPoll = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const runResolve = useCallback(async () => {
    if (!joinToken) {
      setErrorInfo(mapResolveError(new Error("Missing interview link token.")));
      setPhase("error");
      return;
    }
    setPhase("resolve_loading");
    setErrorInfo(null);
    try {
      const resp = await api.resolveInterviewSession({ joinToken });
      setResolved(resp);
      setPhase("room_connecting");
    } catch (e) {
      setErrorInfo(mapResolveError(e));
      setPhase("error");
    }
  }, [joinToken]);

  useEffect(() => {
    runResolve();
  }, [runResolve]);

  useEffect(() => {
    if (phase !== "live" || !resolved?.sessionId) {
      clearPoll();
      return undefined;
    }
    const tick = async () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      try {
        const data = await api.getInterviewSession(resolved.sessionId);
        const st = data?.session?.status;
        const hasEval = Boolean(data?.evaluation);
        if (st === "completed" || st === "ended" || hasEval) {
          clearPoll();
          setCompletion(data);
          setPhase("completed");
        }
      } catch {
        /* ignore transient poll errors */
      }
    };
    tick();
    pollRef.current = setInterval(tick, SESSION_POLL_INTERVAL_MS);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      clearPoll();
    };
  }, [phase, resolved?.sessionId]);

  const handleRoomConnected = useCallback(() => {
    setPhase("live");
  }, []);

  const handleRoomError = useCallback((err) => {
    setErrorInfo(
      mapResolveError(new Error(err?.message || "Could not connect to the interview room."))
    );
    setPhase("error");
    setResolved(null);
  }, []);

  const handleLeaveInterview = async () => {
    if (!resolved?.sessionId || leaving) return;
    const ok = window.confirm("End this interview and leave the room?");
    if (!ok) return;
    setLeaving(true);
    try {
      await api.endInterviewSession(resolved.sessionId, { reason: "candidate_ended" });
      try {
        const data = await api.getInterviewSession(resolved.sessionId);
        setCompletion(data);
      } catch {
        setCompletion({ session: { status: "ended" }, evaluation: null });
      }
      setPhase("completed");
    } catch (e) {
      window.alert(e?.message || "Could not end session.");
    } finally {
      setLeaving(false);
    }
  };

  return (
    <>
      <style>{`
        @keyframes ij-orbit { to { transform: rotate(360deg); } }
        @keyframes ij-pulse-soft {
          0%, 100% { opacity: 0.35; transform: scale(0.98); }
          50% { opacity: 1; transform: scale(1.02); }
        }
        @keyframes ij-shimmer {
          0% { background-position: 0% 50%; }
          100% { background-position: 200% 50%; }
        }
        /* Two-up stage: 2 columns on tablet/desktop; stacked row on mobile (candidate top, AI bottom). */
        .ij-tile-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 8px;
        }
        @media (max-width: 720px) {
          .ij-tile-grid {
            grid-template-columns: 1fr;
            grid-template-rows: minmax(0, 1fr) minmax(0, 1fr);
          }
        }
        .ij-interview-toolbar {
          flex-wrap: nowrap;
        }
        .ij-toolbar-badge {
          flex-shrink: 0;
        }
        .ij-toolbar-live-long {
          display: inline;
        }
        .ij-toolbar-live-short {
          display: none;
        }
        @media (max-width: 420px) {
          .ij-toolbar-live-long {
            display: none;
          }
          .ij-toolbar-live-short {
            display: inline;
          }
          .ij-toolbar-leave-text-long {
            display: none;
          }
          .ij-toolbar-leave-text-short {
            display: inline;
          }
        }
        .ij-toolbar-leave-text-short {
          display: none;
        }
      `}</style>

      {phase === "resolve_loading" && <ResolveLoadingScreen />}

      {phase === "error" && errorInfo && (
        <ErrorScreen info={errorInfo} onRetry={errorInfo.canRetry ? runResolve : null} />
      )}

      {phase === "completed" && (
        <CompletionScreen completion={completion} participantName={resolved?.participantName} />
      )}

      {(phase === "room_connecting" || phase === "live") && resolved && (
        <div style={styles.shell}>
          <div style={styles.roomWrap}>
            <LiveKitRoom
              className="ij-room-shell"
              token={resolved.token}
              serverUrl={resolved.wsUrl}
              connect={phase !== "completed"}
              audio
              video
              onConnected={handleRoomConnected}
              onError={handleRoomError}
              data-lk-theme="default"
              style={styles.lkRoom}
            >
              <div style={styles.roomColumn}>
                <InterviewJoinToolbar
                  participantName={resolved.participantName}
                  onLeave={handleLeaveInterview}
                  leaving={leaving}
                />
                {phase === "room_connecting" && <ConnectingOverlay />}
                <div style={styles.stageStretch}>
                  <InterviewTwoUpStage
                    candidateIdentity={resolved.participantIdentity}
                    onLeave={handleLeaveInterview}
                    leaving={leaving}
                  />
                </div>
                <RoomAudioRenderer />
              </div>
            </LiveKitRoom>
          </div>

          {phase === "live" && (
            <p style={styles.hint}>
              When the AI interviewer finishes, this screen will switch to your summary automatically.
            </p>
          )}
        </div>
      )}

      <div
        style={{
          position: "fixed",
          bottom: 0,
          left: 0,
          right: 0,
          zIndex: 100,
          padding: "10px 16px 14px",
          display: "flex",
          justifyContent: "center",
          pointerEvents: "none",
        }}
      >
        <PoweredByHirecorrecto compact />
      </div>
    </>
  );
}

function connectionStatusUi(state) {
  switch (state) {
    case ConnectionState.Connected:
      return { dot: "#22c55e", label: "Connected", text: "#86efac" };
    case ConnectionState.Connecting:
      return { dot: "#f59e0b", label: "Connecting", text: "#fcd34d" };
    case ConnectionState.Reconnecting:
    case ConnectionState.SignalReconnecting:
      return { dot: "#fb923c", label: "Reconnecting", text: "#fdba74" };
    case ConnectionState.Disconnected:
    default:
      return { dot: "#ef4444", label: "Offline", text: "#fca5a5" };
  }
}

function InterviewJoinToolbar({ participantName, onLeave, leaving }) {
  const conn = useConnectionState();
  const ui = connectionStatusUi(conn);
  const displayName = (participantName && String(participantName).trim()) || "You";
  return (
    <header className="ij-interview-toolbar" style={styles.toolbar}>
      <span className="ij-toolbar-badge" style={styles.toolbarBadge}>
        <Video size={14} strokeWidth={2} aria-hidden />
        <span className="ij-toolbar-live-long">Live interview</span>
        <span className="ij-toolbar-live-short">Live</span>
      </span>
      <div style={styles.toolbarCenter}>
        <span style={styles.toolbarName} title={displayName}>
          {displayName}
        </span>
        <span style={styles.toolbarStatus} title={`Room ${ui.label}`}>
          <span style={{ ...styles.statusDot, background: ui.dot }} aria-hidden />
          <span style={{ ...styles.statusLabel, color: ui.text }}>{ui.label}</span>
        </span>
      </div>
      <button
        type="button"
        style={styles.leaveBtnToolbar}
        onClick={onLeave}
        disabled={leaving}
        aria-label={leaving ? "Leaving interview" : "Leave interview"}
      >
        <LogOut size={15} aria-hidden />
        <span className="ij-toolbar-leave-text-long">{leaving ? "Leaving…" : "Leave interview"}</span>
        <span className="ij-toolbar-leave-text-short">{leaving ? "…" : "Leave"}</span>
      </button>
    </header>
  );
}

function InterviewTwoUpStage({ candidateIdentity, onLeave, leaving }) {
  const room = useRoomContext();
  const [busy, setBusy] = useState("");
  const cameraRefs = useTracks([{ source: Track.Source.Camera, withPlaceholder: true }], {
    onlySubscribed: false,
  });
  const { agent, videoTrack } = useVoiceAssistant();

  const candidateRef = useMemo(() => {
    const found = cameraRefs.find((t) => t.participant?.identity === candidateIdentity);
    if (found) return found;
    return room?.localParticipant
      ? { participant: room.localParticipant, source: Track.Source.Camera }
      : undefined;
  }, [cameraRefs, candidateIdentity, room]);

  const fallbackAgentRef = useMemo(() => {
    const agentByIdentity = agent
      ? cameraRefs.find((t) => t.participant?.identity === agent.identity)
      : undefined;
    if (agentByIdentity) return agentByIdentity;
    return cameraRefs.find(
      (t) =>
        t.participant?.identity !== candidateIdentity &&
        t.participant?.kind === ParticipantKind.AGENT,
    );
  }, [cameraRefs, candidateIdentity, agent]);

  const aiRef = videoTrack || fallbackAgentRef;
  const hasAvatarVideo = Boolean(videoTrack);

  const agentIdentity = useMemo(() => {
    if (agent?.identity) return agent.identity;
    if (fallbackAgentRef?.participant?.identity) return fallbackAgentRef.participant.identity;
    const all = room?.remoteParticipants?.values ? Array.from(room.remoteParticipants.values()) : [];
    const p = all.find((rp) => rp?.kind === ParticipantKind.AGENT);
    return p?.identity || "";
  }, [agent, fallbackAgentRef, room]);

  const micEnabled = Boolean(room?.localParticipant?.isMicrophoneEnabled);
  const camEnabled = Boolean(room?.localParticipant?.isCameraEnabled);
  const shareEnabled = Boolean(room?.localParticipant?.isScreenShareEnabled);

  const withBusy = async (key, fn) => {
    if (!room?.localParticipant) return;
    setBusy(key);
    try {
      await fn();
    } finally {
      setBusy("");
    }
  };

  return (
    <div style={styles.stageRoot}>
      <div style={styles.tileGrid} className="ij-tile-grid">
        <div style={styles.tileCard}>
          {candidateRef ? <ParticipantTile trackRef={candidateRef} style={styles.tile} /> : <EmptyTile label="Candidate" />}
        </div>
        <div style={styles.tileCard}>
          {hasAvatarVideo && aiRef ? (
            <ParticipantTile trackRef={aiRef} style={styles.tile} />
          ) : (
            <AIVoiceBoatIndicator room={room} agentIdentity={agentIdentity} />
          )}
        </div>
      </div>

      <div style={styles.controlsRow}>
        <button
          type="button"
          style={styles.controlBtn}
          disabled={busy !== ""}
          onClick={() =>
            withBusy("mic", () => room.localParticipant.setMicrophoneEnabled(!micEnabled))
          }
        >
          {micEnabled ? <Mic size={16} /> : <MicOff size={16} />}
          {micEnabled ? "Microphone" : "Mic off"}
        </button>
        <button
          type="button"
          style={styles.controlBtn}
          disabled={busy !== ""}
          onClick={() =>
            withBusy("cam", () => room.localParticipant.setCameraEnabled(!camEnabled))
          }
        >
          {camEnabled ? <Camera size={16} /> : <CameraOff size={16} />}
          {camEnabled ? "Camera" : "Cam off"}
        </button>
        <button
          type="button"
          style={styles.controlBtn}
          disabled={busy !== ""}
          onClick={() =>
            withBusy("share", () => room.localParticipant.setScreenShareEnabled(!shareEnabled))
          }
        >
          {shareEnabled ? <ScreenShareOff size={16} /> : <ScreenShare size={16} />}
          {shareEnabled ? "Stop share" : "Share screen"}
        </button>
        <button type="button" style={styles.leaveBtnBottom} onClick={onLeave} disabled={leaving}>
          <LogOut size={16} />
          {leaving ? "Leaving…" : "Leave"}
        </button>
      </div>
    </div>
  );
}

function EmptyTile({ label }) {
  return (
    <div style={styles.emptyTile}>
      <div style={styles.emptyAvatar} />
      <span style={styles.emptyLabel}>{label}</span>
    </div>
  );
}

function ResolveLoadingScreen() {
  return (
    <div style={styles.loadingRoot}>
      <div style={styles.loadingGlow} />
      <div style={styles.loadingCard}>
        <div style={styles.orbitWrap}>
          <div style={styles.orbitRing} />
          <div style={styles.orbitCore}>
            <Sparkles size={28} color="#a5b4fc" strokeWidth={1.75} />
          </div>
        </div>
        <h1 style={styles.loadingTitle}>Preparing your interview</h1>
        <p style={styles.loadingSub}>Securing your room and AI interviewer…</p>
        <div style={styles.loadingDots}>
          <span style={{ ...styles.dot, animationDelay: "0ms" }} />
          <span style={{ ...styles.dot, animationDelay: "160ms" }} />
          <span style={{ ...styles.dot, animationDelay: "320ms" }} />
        </div>
      </div>
    </div>
  );
}

function ConnectingOverlay() {
  return (
    <div style={styles.connectOverlay}>
      <div style={styles.connectInner}>
        <Loader2 size={32} color="#93c5fd" style={{ animation: "ij-orbit 1.2s linear infinite" }} />
        <p style={styles.connectText}>Connecting you to the interview room…</p>
        <p style={styles.connectHint}>Allow camera and microphone when your browser asks.</p>
      </div>
    </div>
  );
}

function ErrorScreen({ info, onRetry }) {
  const Icon = info.variant === "info" ? Info : info.variant === "warn" ? AlertCircle : AlertCircle;
  const accent =
    info.variant === "info"
      ? "#3b82f6"
      : info.variant === "warn"
        ? "#d97706"
        : info.variant === "neutral"
          ? "#64748b"
          : "#dc2626";
  return (
    <div style={styles.loadingRoot}>
      <div style={styles.loadingGlow} />
      <div style={{ ...styles.loadingCard, maxWidth: 440 }}>
        <div
          style={{
            width: 56,
            height: 56,
            borderRadius: 16,
            background: `${accent}18`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            marginBottom: 16,
          }}
        >
          <Icon size={28} color={accent} strokeWidth={2} />
        </div>
        <h1 style={{ ...styles.loadingTitle, fontSize: "1.35rem" }}>{info.title}</h1>
        <p style={{ ...styles.loadingSub, marginBottom: 20 }}>{info.message}</p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {onRetry && (
            <button type="button" style={styles.primaryBtn} onClick={onRetry}>
              <RefreshCw size={16} />
              Try again
            </button>
          )}
          <button
            type="button"
            style={styles.ghostBtn}
            onClick={() => window.location.reload()}
          >
            Reload page
          </button>
        </div>
      </div>
    </div>
  );
}

function CompletionScreen({ completion, participantName }) {
  const evalDoc = completion?.evaluation;
  const summary = evalDoc?.summary;
  const overall = evalDoc?.overallPercent;
  const rec = evalDoc?.recommendation;
  return (
    <div style={styles.loadingRoot}>
      <div style={{ ...styles.loadingGlow, opacity: 0.6 }} />
      <div style={{ ...styles.loadingCard, maxWidth: 480 }}>
        <div
          style={{
            width: 56,
            height: 56,
            borderRadius: 16,
            background: "rgba(34,197,94,0.15)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            marginBottom: 16,
          }}
        >
          <CheckCircle2 size={30} color="#22c55e" strokeWidth={2} />
        </div>
        <h1 style={{ ...styles.loadingTitle, fontSize: "1.4rem" }}>Interview complete</h1>
        <p style={{ ...styles.loadingSub, marginBottom: 16 }}>
          {participantName ? `Thank you, ${participantName}. ` : "Thank you. "}
          You can close this tab. Your recruiter may follow up with next steps.
        </p>
        {summary && (
          <div style={styles.summaryBox}>
            <strong style={{ display: "block", marginBottom: 8, color: "#e2e8f0" }}>Summary</strong>
            <p style={{ margin: 0, color: "#cbd5e1", fontSize: "0.95rem", lineHeight: 1.5 }}>{summary}</p>
            {overall != null && (
              <p style={{ margin: "12px 0 0", color: "#94a3b8", fontSize: "0.88rem" }}>
                Overall score: <strong style={{ color: "#e2e8f0" }}>{overall}%</strong>
                {rec ? ` · ${rec}` : ""}
              </p>
            )}
          </div>
        )}
        {!summary && (
          <p style={{ ...styles.loadingSub, fontSize: "0.9rem" }}>
            Results may take a minute to appear in your dashboard.
          </p>
        )}
      </div>
    </div>
  );
}

const styles = {
  shell: {
    height: "100vh",
    background: "linear-gradient(165deg, #0f172a 0%, #1e1b4b 45%, #0f172a 100%)",
    padding: "clamp(10px, 2vw, 16px)",
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  },
  roomColumn: {
    height: "100%",
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    position: "relative",
  },
  toolbar: {
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    padding: "8px 10px",
    borderBottom: "1px solid rgba(148,163,184,0.18)",
    background: "rgba(15,23,42,0.96)",
    zIndex: 25,
    position: "relative",
    boxSizing: "border-box",
  },
  toolbarBadge: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    background: "rgba(99,102,241,0.25)",
    border: "1px solid rgba(165,180,252,0.35)",
    color: "#e0e7ff",
    padding: "6px 12px",
    borderRadius: 999,
    fontSize: "0.8rem",
    fontWeight: 600,
  },
  toolbarCenter: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  toolbarName: {
    color: "#e2e8f0",
    fontSize: "0.8rem",
    fontWeight: 600,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    minWidth: 0,
    flex: "1 1 36%",
    maxWidth: "50%",
  },
  toolbarStatus: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    flexShrink: 0,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: "50%",
    flexShrink: 0,
    boxShadow: "0 0 0 1px rgba(0,0,0,0.35)",
  },
  statusLabel: {
    fontSize: "0.72rem",
    fontWeight: 600,
    letterSpacing: "0.02em",
    textTransform: "uppercase",
  },
  leaveBtnToolbar: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    flexShrink: 0,
    background: "rgba(239,68,68,0.15)",
    border: "1px solid rgba(248,113,113,0.45)",
    color: "#fecaca",
    padding: "7px 11px",
    borderRadius: 8,
    cursor: "pointer",
    fontSize: "0.78rem",
    fontWeight: 500,
  },
  stageStretch: {
    flex: 1,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    position: "relative",
  },
  roomWrap: {
    position: "relative",
    borderRadius: 16,
    overflow: "hidden",
    border: "1px solid rgba(148,163,184,0.2)",
    boxShadow: "0 25px 50px -12px rgba(0,0,0,0.45)",
    flex: 1,
    minHeight: 0,
    maxHeight: "calc(100vh - 80px)",
  },
  lkRoom: {
    height: "100%",
    minHeight: 0,
    background: "#020617",
  },
  stageRoot: {
    height: "100%",
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    padding: 8,
    boxSizing: "border-box",
    gap: 8,
  },
  tileGrid: {
    flex: 1,
    minHeight: 0,
    /* display / columns: see .ij-tile-grid in <style> for responsive layout */
  },
  tileCard: {
    minHeight: 0,
    borderRadius: 10,
    overflow: "hidden",
    border: "1px solid rgba(148,163,184,0.25)",
    background: "#0b1220",
    position: "relative",
  },
  tile: {
    width: "100%",
    height: "100%",
  },
  emptyTile: {
    width: "100%",
    height: "100%",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    color: "#94a3b8",
  },
  emptyAvatar: {
    width: 86,
    height: 86,
    borderRadius: "50%",
    background: "rgba(148,163,184,0.25)",
  },
  emptyLabel: {
    fontSize: "0.82rem",
    fontWeight: 600,
  },
  controlsRow: {
    display: "flex",
    gap: 8,
    justifyContent: "center",
    alignItems: "center",
    flexWrap: "wrap",
    paddingBottom: 4,
  },
  controlBtn: {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    background: "rgba(15,23,42,0.85)",
    color: "#e2e8f0",
    border: "1px solid rgba(148,163,184,0.3)",
    borderRadius: 8,
    padding: "8px 12px",
    cursor: "pointer",
    fontSize: "0.84rem",
  },
  leaveBtnBottom: {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    background: "rgba(127,29,29,0.22)",
    color: "#fecaca",
    border: "1px solid rgba(248,113,113,0.45)",
    borderRadius: 8,
    padding: "8px 12px",
    cursor: "pointer",
    fontSize: "0.84rem",
  },
  hint: {
    marginTop: 14,
    textAlign: "center",
    color: "#64748b",
    fontSize: "0.82rem",
    maxWidth: 560,
    marginLeft: "auto",
    marginRight: "auto",
  },
  loadingRoot: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    position: "relative",
    overflow: "hidden",
    background: "linear-gradient(165deg, #020617 0%, #1e1b4b 40%, #020617 100%)",
    boxSizing: "border-box",
  },
  loadingGlow: {
    position: "absolute",
    width: "min(90vw, 520px)",
    height: "min(90vw, 520px)",
    borderRadius: "50%",
    background: "radial-gradient(circle, rgba(99,102,241,0.35) 0%, transparent 65%)",
    filter: "blur(40px)",
    animation: "ij-pulse-soft 4s ease-in-out infinite",
    pointerEvents: "none",
  },
  loadingCard: {
    position: "relative",
    zIndex: 1,
    textAlign: "center",
    padding: "clamp(24px, 5vw, 40px)",
    borderRadius: 20,
    background: "rgba(15,23,42,0.65)",
    border: "1px solid rgba(148,163,184,0.18)",
    backdropFilter: "blur(12px)",
    maxWidth: 420,
    width: "100%",
  },
  orbitWrap: {
    position: "relative",
    width: 88,
    height: 88,
    margin: "0 auto 24px",
  },
  orbitRing: {
    position: "absolute",
    inset: 0,
    borderRadius: "50%",
    border: "2px solid transparent",
    borderTopColor: "#818cf8",
    borderRightColor: "rgba(129,140,248,0.35)",
    animation: "ij-orbit 1.8s linear infinite",
  },
  orbitCore: {
    position: "absolute",
    inset: 18,
    borderRadius: "50%",
    background: "linear-gradient(145deg, rgba(79,70,229,0.4), rgba(30,27,75,0.9))",
    border: "1px solid rgba(165,180,252,0.35)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    animation: "ij-pulse-soft 2.5s ease-in-out infinite",
  },
  loadingTitle: {
    margin: 0,
    fontSize: "1.5rem",
    fontWeight: 700,
    color: "#f1f5f9",
    letterSpacing: "-0.02em",
  },
  loadingSub: {
    margin: "12px 0 0",
    color: "#94a3b8",
    fontSize: "0.95rem",
    lineHeight: 1.5,
  },
  loadingDots: {
    display: "flex",
    justifyContent: "center",
    gap: 8,
    marginTop: 24,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: "50%",
    background: "#818cf8",
    animation: "ij-pulse-soft 1.2s ease-in-out infinite",
  },
  connectOverlay: {
    position: "absolute",
    inset: 0,
    zIndex: 20,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(2,6,23,0.85)",
    backdropFilter: "blur(8px)",
  },
  connectInner: {
    textAlign: "center",
    padding: 24,
    maxWidth: 320,
  },
  connectText: {
    margin: "16px 0 8px",
    color: "#e2e8f0",
    fontSize: "1.05rem",
    fontWeight: 600,
  },
  connectHint: {
    margin: 0,
    color: "#64748b",
    fontSize: "0.85rem",
    lineHeight: 1.45,
  },
  primaryBtn: {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    background: "linear-gradient(135deg, #6366f1, #4f46e5)",
    border: "none",
    color: "#fff",
    padding: "12px 20px",
    borderRadius: 10,
    cursor: "pointer",
    fontWeight: 600,
    fontSize: "0.9rem",
  },
  ghostBtn: {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    background: "transparent",
    border: "1px solid rgba(148,163,184,0.35)",
    color: "#cbd5e1",
    padding: "12px 20px",
    borderRadius: 10,
    cursor: "pointer",
    fontWeight: 500,
    fontSize: "0.9rem",
  },
  summaryBox: {
    textAlign: "left",
    marginTop: 8,
    padding: 16,
    borderRadius: 12,
    background: "rgba(15,23,42,0.75)",
    border: "1px solid rgba(148,163,184,0.15)",
  },
};

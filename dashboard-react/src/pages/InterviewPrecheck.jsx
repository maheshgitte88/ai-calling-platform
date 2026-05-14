import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  Camera,
  CheckCircle2,
  Loader2,
  Mic,
  RefreshCw,
  Sparkles,
  Volume2,
} from "lucide-react";
import { api } from "../services/api";
import PoweredByHirecorrecto from "../components/PoweredByHirecorrecto";

const MIN_RECORD_MS = 2500;
const TEST_PHRASE = "I'm ready to begin my interview.";
const JPEG_QUALITY = 0.82;

const pStyles = {
  root: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "center",
    padding: "24px 16px 100px",
    position: "relative",
    overflow: "auto",
    background: "linear-gradient(165deg, #020617 0%, #1e1b4b 40%, #020617 100%)",
    boxSizing: "border-box",
  },
  glow: {
    position: "fixed",
    width: "min(90vw, 520px)",
    height: "min(90vw, 520px)",
    borderRadius: "50%",
    background: "radial-gradient(circle, rgba(99,102,241,0.28) 0%, transparent 65%)",
    filter: "blur(40px)",
    animation: "ij-pulse-soft 4s ease-in-out infinite",
    pointerEvents: "none",
    top: "10%",
    left: "50%",
    transform: "translateX(-50%)",
  },
  card: {
    position: "relative",
    zIndex: 1,
    width: "100%",
    maxWidth: 640,
    padding: "clamp(20px, 4vw, 32px)",
    borderRadius: 20,
    background: "rgba(15,23,42,0.72)",
    border: "1px solid rgba(148,163,184,0.18)",
    backdropFilter: "blur(12px)",
    boxSizing: "border-box",
  },
  title: {
    margin: 0,
    fontSize: "1.35rem",
    fontWeight: 700,
    color: "#f1f5f9",
    letterSpacing: "-0.02em",
  },
  sub: {
    margin: "8px 0 0",
    color: "#94a3b8",
    fontSize: "0.9rem",
    lineHeight: 1.5,
  },
  section: {
    marginTop: 22,
    paddingTop: 18,
    borderTop: "1px solid rgba(148,163,184,0.12)",
  },
  sectionLabel: {
    fontSize: "0.78rem",
    fontWeight: 700,
    color: "#a5b4fc",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    marginBottom: 10,
  },
  instructionsBox: {
    textAlign: "left",
    maxHeight: 220,
    overflowY: "auto",
    padding: 14,
    borderRadius: 12,
    background: "rgba(2,6,23,0.55)",
    border: "1px solid rgba(148,163,184,0.15)",
    color: "#e2e8f0",
    fontSize: "0.88rem",
    lineHeight: 1.55,
    whiteSpace: "pre-wrap",
  },
  rulesBox: {
    marginTop: 10,
    fontSize: "0.78rem",
    color: "#94a3b8",
    lineHeight: 1.45,
    maxHeight: 100,
    overflowY: "auto",
  },
  videoWrap: {
    marginTop: 12,
    borderRadius: 12,
    overflow: "hidden",
    border: "1px solid rgba(148,163,184,0.25)",
    background: "#020617",
    aspectRatio: "16 / 10",
    maxHeight: 280,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#64748b",
    fontSize: "0.85rem",
  },
  video: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
  },
  meterTrack: {
    height: 8,
    borderRadius: 999,
    background: "rgba(30,41,59,0.9)",
    overflow: "hidden",
    marginTop: 10,
  },
  meterFill: {
    height: "100%",
    borderRadius: 999,
    background: "linear-gradient(90deg, #22c55e, #4ade80)",
    transition: "width 0.08s linear",
  },
  primaryBtn: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    background: "linear-gradient(135deg, #6366f1, #4f46e5)",
    border: "none",
    color: "#fff",
    padding: "11px 18px",
    borderRadius: 10,
    cursor: "pointer",
    fontWeight: 600,
    fontSize: "0.88rem",
    marginTop: 10,
  },
  secondaryBtn: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    background: "rgba(15,23,42,0.85)",
    color: "#e2e8f0",
    border: "1px solid rgba(148,163,184,0.35)",
    borderRadius: 10,
    padding: "11px 18px",
    cursor: "pointer",
    fontWeight: 600,
    fontSize: "0.88rem",
    marginTop: 10,
    marginRight: 10,
  },
  row: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 10,
  },
  statusOk: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    color: "#86efac",
    fontSize: "0.82rem",
    fontWeight: 600,
  },
  statusErr: {
    color: "#fca5a5",
    fontSize: "0.82rem",
    marginTop: 8,
  },
  phrase: {
    marginTop: 10,
    padding: "12px 14px",
    borderRadius: 10,
    background: "rgba(30,27,75,0.45)",
    border: "1px solid rgba(165,180,252,0.25)",
    color: "#e0e7ff",
    fontSize: "0.95rem",
    fontWeight: 600,
    fontStyle: "italic",
  },
  checkboxRow: {
    display: "flex",
    alignItems: "flex-start",
    gap: 10,
    marginTop: 18,
    color: "#cbd5e1",
    fontSize: "0.88rem",
    lineHeight: 1.45,
  },
  startBtn: {
    display: "flex",
    width: "100%",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    marginTop: 22,
    background: "linear-gradient(135deg, #22c55e, #16a34a)",
    border: "none",
    color: "#fff",
    padding: "14px 20px",
    borderRadius: 12,
    cursor: "pointer",
    fontWeight: 700,
    fontSize: "1rem",
  },
  startBtnDisabled: {
    opacity: 0.45,
    cursor: "not-allowed",
  },
  loadingRoot: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    background: "linear-gradient(165deg, #020617 0%, #1e1b4b 40%, #020617 100%)",
  },
  loadingCard: {
    textAlign: "center",
    padding: 40,
    borderRadius: 20,
    background: "rgba(15,23,42,0.65)",
    border: "1px solid rgba(148,163,184,0.18)",
    maxWidth: 400,
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
    marginTop: 16,
  },
  metaHint: {
    fontSize: "0.75rem",
    color: "#64748b",
    marginTop: 8,
  },
};

function mapPrecheckMetaError(err) {
  const msg = err?.message || String(err || "Something went wrong.");
  const lower = msg.toLowerCase();
  if (lower.includes("already completed")) {
    return {
      title: "Interview already completed",
      message:
        "This interview session was finished. If you need another attempt, ask your recruiter to send a new link.",
    };
  }
  if (lower.includes("already ended")) {
    return {
      title: "Interview has ended",
      message: "This session is no longer active. Contact support if you still need access.",
    };
  }
  if (lower.includes("not found") || lower.includes("join token") || lower.includes("expired")) {
    return {
      title: "Link invalid or expired",
      message: "Open the interview link from your invitation again, or request a new link.",
    };
  }
  return {
    title: "Unable to load interview",
    message: msg,
  };
}

/**
 * @param {{ joinToken: string; onPrecheckPassed: () => void }} props
 */
export default function InterviewPrecheck({ joinToken, onPrecheckPassed }) {
  const [metaLoading, setMetaLoading] = useState(true);
  const [meta, setMeta] = useState(null);
  const [metaError, setMetaError] = useState(null);

  const [mediaStream, setMediaStream] = useState(null);
  const [deviceError, setDeviceError] = useState(null);
  const [micLevel, setMicLevel] = useState(0);

  const [identityBusy, setIdentityBusy] = useState(false);
  const [identityOk, setIdentityOk] = useState(false);
  const [identityErr, setIdentityErr] = useState(null);

  const [audioPhase, setAudioPhase] = useState("idle");
  const [audioErr, setAudioErr] = useState(null);
  const [audioOk, setAudioOk] = useState(false);

  const [termsChecked, setTermsChecked] = useState(false);

  const videoRef = useRef(null);
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const rafRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const recordChunksRef = useRef([]);
  const recordStartedAtRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setMetaLoading(true);
      setMetaError(null);
      try {
        const data = await api.getInterviewPrecheckMeta(joinToken);
        if (!cancelled) setMeta(data);
      } catch (e) {
        if (!cancelled) setMetaError(mapPrecheckMetaError(e));
      } finally {
        if (!cancelled) setMetaLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [joinToken]);

  const stopMicMeter = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    try {
      audioContextRef.current?.close?.();
    } catch {
      /* ignore */
    }
    audioContextRef.current = null;
    analyserRef.current = null;
  }, []);

  const stopMediaStream = useCallback(() => {
    stopMicMeter();
    setMediaStream((prev) => {
      prev?.getTracks?.().forEach((t) => {
        try {
          t.stop();
        } catch {
          /* ignore */
        }
      });
      return null;
    });
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, [stopMicMeter]);

  useEffect(() => () => stopMediaStream(), [stopMediaStream]);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return undefined;
    if (!mediaStream) {
      el.srcObject = null;
      return undefined;
    }
    el.srcObject = mediaStream;
    el.muted = true;
    el.playsInline = true;
    const p = el.play();
    if (p && typeof p.catch === "function") p.catch(() => {});
    return undefined;
  }, [mediaStream]);

  useEffect(() => {
    if (!mediaStream) {
      setMicLevel(0);
      return undefined;
    }
    const track = mediaStream.getAudioTracks()[0];
    if (!track) return undefined;

    let ctx;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      const source = ctx.createMediaStreamSource(new MediaStream([track]));
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      audioContextRef.current = ctx;
      analyserRef.current = analyser;
    } catch {
      return undefined;
    }

    const data = new Uint8Array(analyserRef.current?.frequencyBinCount || 128);
    const tick = () => {
      const an = analyserRef.current;
      if (!an) return;
      an.getByteFrequencyData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i += 1) sum += data[i];
      const avg = sum / (data.length * 255);
      setMicLevel((prev) => prev * 0.65 + avg * 0.35);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      try {
        ctx?.close?.();
      } catch {
        /* ignore */
      }
      if (audioContextRef.current === ctx) audioContextRef.current = null;
      analyserRef.current = null;
    };
  }, [mediaStream]);

  const requestDevices = useCallback(async () => {
    setDeviceError(null);
    setIdentityOk(false);
    setIdentityErr(null);
    setAudioOk(false);
    setAudioErr(null);
    setAudioPhase("idle");
    stopMicMeter();
    setMediaStream((prev) => {
      prev?.getTracks?.().forEach((t) => {
        try {
          t.stop();
        } catch {
          /* ignore */
        }
      });
      return null;
    });
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      setMediaStream(stream);
    } catch (e) {
      setDeviceError(e?.message || "Could not access camera or microphone.");
    }
  }, [stopMicMeter]);

  const captureAndUploadIdentity = useCallback(async () => {
    setIdentityErr(null);
    const video = videoRef.current;
    if (!video || !mediaStream?.getVideoTracks()?.length) {
      setIdentityErr("Turn on your camera first.");
      return;
    }
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) {
      setIdentityErr("Wait for the camera preview to load, then try again.");
      return;
    }
    setIdentityBusy(true);
    try {
      const canvas = document.createElement("canvas");
      const maxW = 1280;
      const cw = Math.min(w, maxW);
      const ch = Math.max(1, Math.round((h / w) * cw));
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Could not read camera frame.");
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve) => {
        canvas.toBlob((b) => resolve(b), "image/jpeg", JPEG_QUALITY);
      });
      if (!blob) throw new Error("Could not encode image.");
      await api.uploadInterviewPrecheckIdentity(blob, joinToken);
      setIdentityOk(true);
    } catch (e) {
      setIdentityErr(e?.message || "Snapshot upload failed.");
      setIdentityOk(false);
    } finally {
      setIdentityBusy(false);
    }
  }, [joinToken, mediaStream]);

  const startRecording = useCallback(() => {
    if (!mediaStream?.getAudioTracks()?.length) {
      setAudioErr("Microphone is not available.");
      return;
    }
    setAudioErr(null);
    setAudioOk(false);
    recordChunksRef.current = [];
    const mime =
      typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
    try {
      const rec = new MediaRecorder(new MediaStream(mediaStream.getAudioTracks()), { mimeType: mime });
      mediaRecorderRef.current = rec;
      rec.ondataavailable = (ev) => {
        if (ev.data?.size) recordChunksRef.current.push(ev.data);
      };
      rec.onerror = () => {
        setAudioErr("Recording error.");
        setAudioPhase("idle");
      };
      rec.start(200);
      recordStartedAtRef.current = Date.now();
      setAudioPhase("recording");
    } catch (e) {
      setAudioErr(e?.message || "Could not start recording.");
    }
  }, [mediaStream]);

  const stopRecordingAndUpload = useCallback(async () => {
    const rec = mediaRecorderRef.current;
    if (!rec || audioPhase !== "recording") return;
    const elapsed = Date.now() - recordStartedAtRef.current;
    if (elapsed < MIN_RECORD_MS) {
      setAudioErr(`Please record for at least ${Math.ceil(MIN_RECORD_MS / 1000)} seconds.`);
      return;
    }
    setAudioPhase("uploading");
    setAudioErr(null);
    await new Promise((resolve) => {
      rec.onstop = resolve;
      try {
        if (rec.state === "recording" && typeof rec.requestData === "function") {
          rec.requestData();
        }
        if (rec.state === "recording") {
          rec.stop();
        } else {
          resolve();
        }
      } catch {
        resolve();
      }
    });
    mediaRecorderRef.current = null;
    try {
      const blob = new Blob(recordChunksRef.current, { type: rec.mimeType || "audio/webm" });
      recordChunksRef.current = [];
      if (blob.size < 2048) {
        throw new Error("Recording too short or empty.");
      }
      await api.uploadInterviewPrecheckAudio(blob, joinToken);
      setAudioOk(true);
      setAudioPhase("done");
    } catch (e) {
      setAudioErr(e?.message || "Audio check failed.");
      setAudioPhase("idle");
    }
  }, [audioPhase, joinToken]);

  const devicesReady = Boolean(
    mediaStream?.getVideoTracks()?.length &&
      mediaStream.getVideoTracks()[0].readyState !== "ended" &&
      mediaStream.getAudioTracks()?.length &&
      mediaStream.getAudioTracks()[0].readyState !== "ended",
  );
  const canStartInterview =
    devicesReady &&
    identityOk &&
    audioOk &&
    termsChecked &&
    !metaLoading &&
    meta &&
    !metaError;

  if (metaLoading) {
    return (
      <div style={pStyles.loadingRoot}>
        <style>{`
          @keyframes ij-pulse-soft {
            0%, 100% { opacity: 0.35; transform: scale(0.98); }
            50% { opacity: 1; transform: scale(1.02); }
          }
        `}</style>
        <div style={pStyles.loadingCard}>
          <Loader2 size={36} color="#818cf8" style={{ animation: "ij-pulse-soft 1.2s ease-in-out infinite" }} />
          <p style={{ ...pStyles.title, marginTop: 20, fontSize: "1.1rem" }}>Loading interview details…</p>
        </div>
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
      </div>
    );
  }

  if (metaError) {
    return (
      <div style={pStyles.loadingRoot}>
        <div style={pStyles.loadingCard}>
          <AlertCircle size={36} color="#f87171" style={{ marginBottom: 8 }} />
          <h1 style={{ ...pStyles.title, fontSize: "1.2rem" }}>{metaError.title}</h1>
          <p style={pStyles.sub}>{metaError.message}</p>
          <button type="button" style={pStyles.ghostBtn} onClick={() => window.location.reload()}>
            <RefreshCw size={16} />
            Reload page
          </button>
        </div>
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
      </div>
    );
  }

  return (
    <>
      <style>{`
        @keyframes ij-pulse-soft {
          0%, 100% { opacity: 0.35; transform: scale(0.98); }
          50% { opacity: 1; transform: scale(1.02); }
        }
      `}</style>
      <div style={pStyles.root}>
        <div style={pStyles.glow} />
        <div style={pStyles.card}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: 12,
                background: "linear-gradient(145deg, rgba(79,70,229,0.45), rgba(30,27,75,0.95))",
                border: "1px solid rgba(165,180,252,0.35)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Sparkles size={22} color="#c7d2fe" strokeWidth={1.75} />
            </div>
            <div>
              <h1 style={pStyles.title}>{meta?.interviewTitle || "AI Interview"}</h1>
              <p style={pStyles.sub}>
                Hello{meta?.participantName ? `, ${meta.participantName}` : ""}. Complete the checks below, then
                start the interview.
              </p>
            </div>
          </div>
          {meta?.linkExpiresAt && (
            <p style={pStyles.metaHint}>This join link expires: {new Date(meta.linkExpiresAt).toLocaleString()}</p>
          )}

          <div style={pStyles.section}>
            <div style={pStyles.sectionLabel}>Instructions</div>
            {meta?.instructions ? (
              <div style={pStyles.instructionsBox}>{meta.instructions}</div>
            ) : (
              <div style={pStyles.instructionsBox}>
                Stay in a quiet place, face the camera, and speak clearly. You will interview with an AI
                interviewer; answer naturally and wait for each question to finish.
              </div>
            )}
            {meta?.rulesSummary ? (
              <div style={pStyles.rulesBox}>
                <strong style={{ color: "#94a3b8" }}>Interview rules (summary):</strong> {meta.rulesSummary}
              </div>
            ) : null}
          </div>

          <div style={pStyles.section}>
            <div style={pStyles.sectionLabel}>Camera and microphone</div>
            <p style={{ ...pStyles.sub, marginTop: 0 }}>
              We need access to your camera and microphone for this video interview.
            </p>
            <div style={pStyles.row}>
              <button type="button" style={pStyles.secondaryBtn} onClick={requestDevices}>
                <Camera size={18} />
                {mediaStream ? "Reconnect devices" : "Allow camera & microphone"}
              </button>
              {devicesReady && (
                <span style={pStyles.statusOk}>
                  <CheckCircle2 size={16} />
                  Devices active
                </span>
              )}
            </div>
            {deviceError && <p style={pStyles.statusErr}>{deviceError}</p>}
            <div style={pStyles.videoWrap}>
              {devicesReady ? (
                <video ref={videoRef} style={pStyles.video} playsInline muted />
              ) : (
                <span>Preview appears here after you allow access</span>
              )}
            </div>
            {devicesReady && (
              <>
                <div style={{ ...pStyles.row, marginTop: 10 }}>
                  <Mic size={16} color="#94a3b8" />
                  <span style={{ fontSize: "0.8rem", color: "#94a3b8" }}>Input level</span>
                </div>
                <div style={pStyles.meterTrack}>
                  <div style={{ ...pStyles.meterFill, width: `${Math.min(100, micLevel * 400)}%` }} />
                </div>
              </>
            )}
          </div>

          <div style={pStyles.section}>
            <div style={pStyles.sectionLabel}>Identity snapshot</div>
            <p style={{ ...pStyles.sub, marginTop: 0 }}>
              Capture a clear photo of your face (similar to an ID check). This is stored with your session for
              verification.
            </p>
            <button
              type="button"
              style={{
                ...pStyles.secondaryBtn,
                opacity: devicesReady ? 1 : 0.5,
                cursor: devicesReady ? "pointer" : "not-allowed",
              }}
              disabled={!devicesReady || identityBusy}
              onClick={captureAndUploadIdentity}
            >
              {identityBusy ? (
                <>
                  <Loader2 size={18} style={{ animation: "ij-pulse-soft 1s ease-in-out infinite" }} />
                  Uploading…
                </>
              ) : (
                <>
                  <Camera size={18} />
                  Capture snapshot
                </>
              )}
            </button>
            {identityOk && (
              <span style={{ ...pStyles.statusOk, marginLeft: 8 }}>
                <CheckCircle2 size={16} />
                Snapshot saved
              </span>
            )}
            {identityErr && <p style={pStyles.statusErr}>{identityErr}</p>}
          </div>

          <div style={pStyles.section}>
            <div style={pStyles.sectionLabel}>Microphone audio test</div>
            <p style={{ ...pStyles.sub, marginTop: 0 }}>
              Record yourself saying the phrase below. We upload a short clip to confirm your microphone is working.
            </p>
            <div style={pStyles.phrase}>&ldquo;{TEST_PHRASE}&rdquo;</div>
            <div style={pStyles.row}>
              {audioPhase !== "recording" ? (
                <button
                  type="button"
                  style={{
                    ...pStyles.secondaryBtn,
                    opacity: devicesReady && audioPhase !== "uploading" ? 1 : 0.5,
                    cursor: devicesReady && audioPhase !== "uploading" ? "pointer" : "not-allowed",
                  }}
                  disabled={!devicesReady || audioPhase === "uploading"}
                  onClick={startRecording}
                >
                  <Volume2 size={18} />
                  Start recording
                </button>
              ) : (
                <button type="button" style={pStyles.primaryBtn} onClick={stopRecordingAndUpload}>
                  Stop &amp; verify
                </button>
              )}
              {audioPhase === "recording" && (
                <span style={{ color: "#fde68a", fontSize: "0.85rem", fontWeight: 600 }}>Recording…</span>
              )}
              {audioPhase === "uploading" && (
                <span style={{ color: "#93c5fd", fontSize: "0.85rem" }}>Verifying with server…</span>
              )}
              {audioOk && (
                <span style={pStyles.statusOk}>
                  <CheckCircle2 size={16} />
                  Audio verified
                </span>
              )}
            </div>
            {audioErr && <p style={pStyles.statusErr}>{audioErr}</p>}
          </div>

          <label style={pStyles.checkboxRow}>
            <input
              type="checkbox"
              checked={termsChecked}
              onChange={(e) => setTermsChecked(e.target.checked)}
              style={{ marginTop: 3 }}
            />
            <span>I have read the instructions and I am ready to begin the interview.</span>
          </label>

          <button
            type="button"
            style={{
              ...pStyles.startBtn,
              ...(!canStartInterview ? pStyles.startBtnDisabled : {}),
            }}
            disabled={!canStartInterview}
            onClick={() => {
              if (canStartInterview) onPrecheckPassed();
            }}
          >
            Start interview
          </button>
        </div>
      </div>
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

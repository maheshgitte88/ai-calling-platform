import { useEffect, useMemo, useRef, useState } from "react";
import { ParticipantKind, RoomEvent } from "livekit-client";

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function findAgentParticipant(room, agentIdentity) {
  if (!room) return undefined;
  if (agentIdentity && room.remoteParticipants?.get) {
    const p = room.remoteParticipants.get(agentIdentity);
    if (p) return p;
  }
  const all = room.remoteParticipants?.values ? Array.from(room.remoteParticipants.values()) : [];
  return all.find((p) => p?.kind === ParticipantKind.AGENT);
}

export default function AIVoiceBoatIndicator({
  room,
  agentIdentity,
  active = true,
  label = "AI interviewer voice",
}) {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [intensity, setIntensity] = useState(0);
  const targetRef = useRef(0);
  const speakingRef = useRef(false);

  const agentParticipant = useMemo(() => findAgentParticipant(room, agentIdentity), [room, agentIdentity]);

  useEffect(() => {
    if (!room || !active) return undefined;

    const updateFromParticipant = () => {
      const p = findAgentParticipant(room, agentIdentity);
      const level = clamp01(typeof p?.audioLevel === "number" ? p.audioLevel : 0);
      const speaking = Boolean(p?.isSpeaking) || level > 0.14;
      targetRef.current = level;
      speakingRef.current = speaking;
    };

    // Prime immediately; then refresh on active speaker changes and join/leave.
    updateFromParticipant();
    room.on(RoomEvent.ActiveSpeakersChanged, updateFromParticipant);
    room.on(RoomEvent.ParticipantConnected, updateFromParticipant);
    room.on(RoomEvent.ParticipantDisconnected, updateFromParticipant);
    room.on(RoomEvent.ParticipantAttributesChanged, updateFromParticipant);

    const tick = window.setInterval(() => {
      // Smooth intensity for nicer motion.
      setIntensity((prev) => {
        const next = prev + (targetRef.current - prev) * 0.18;
        return clamp01(next);
      });
      setIsSpeaking(speakingRef.current);
    }, 50);

    return () => {
      window.clearInterval(tick);
      room.off(RoomEvent.ActiveSpeakersChanged, updateFromParticipant);
      room.off(RoomEvent.ParticipantConnected, updateFromParticipant);
      room.off(RoomEvent.ParticipantDisconnected, updateFromParticipant);
      room.off(RoomEvent.ParticipantAttributesChanged, updateFromParticipant);
    };
  }, [room, agentIdentity, active]);

  const i = clamp01(active ? intensity : 0);
  const speaking = Boolean(active && isSpeaking);
  const ringDots = useMemo(
    () =>
      Array.from({ length: 28 }, (_, idx) => {
        const angle = (idx / 28) * Math.PI * 2 - Math.PI / 2;
        return { idx, angle };
      }),
    [],
  );

  return (
    <div
      aria-label={speaking ? `${label}: speaking` : `${label}: idle`}
      title={agentParticipant?.identity ? `AI: ${agentParticipant.identity}` : "AI voice"}
      style={{
        userSelect: "none",
        display: "flex",
        alignItems: "stretch",
        justifyContent: "stretch",
        width: "100%",
        height: "100%",
      }}
    >
      <style>{`
        @keyframes ij-ai-avatar-float {
          0%, 100% { transform: translateY(-2px); }
          50% { transform: translateY(2px); }
        }
        @keyframes ij-boat-glow {
          0%, 100% { opacity: 0.35; }
          50% { opacity: 0.95; }
        }
        @keyframes ij-ai-grid-move {
          from { transform: translate3d(0, 0, 0); }
          to { transform: translate3d(-24px, 0, 0); }
        }
        @media (prefers-reduced-motion: reduce) {
          .ij-ai-avatar-float { animation-duration: 2.4s !important; }
        }
      `}</style>

      <div
        style={{
          "--i": String(i),
          width: "100%",
          height: "100%",
          borderRadius: 0,
          border: "1px solid rgba(148,163,184,0.22)",
          background: speaking
            ? "linear-gradient(165deg, rgba(2,6,23,0.96), rgba(30,27,75,0.88) 60%, rgba(2,6,23,0.98))"
            : "linear-gradient(165deg, rgba(15,23,42,0.8), rgba(51,65,85,0.55) 60%, rgba(15,23,42,0.88))",
          backdropFilter: "blur(14px)",
          boxShadow: speaking
            ? "0 10px 25px rgba(0,0,0,0.45), 0 0 0 1px rgba(99,102,241,0.25) inset"
            : "0 10px 22px rgba(0,0,0,0.35)",
          overflow: "hidden",
          position: "relative",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            opacity: speaking ? 0.22 : 0.1,
            backgroundImage:
              "linear-gradient(transparent 96%, rgba(148,163,184,0.2) 100%), linear-gradient(90deg, transparent 96%, rgba(148,163,184,0.15) 100%)",
            backgroundSize: "24px 24px",
            animation: `ij-ai-grid-move ${speaking ? "1.2s" : "3.4s"} linear infinite`,
          }}
        />

        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
            zIndex: 3,
          }}
        >
          <div
            className="ij-ai-avatar-float"
            style={{
              width: "80%",
              height: "80%",
              maxWidth: 350,
              maxHeight: 350,
              minWidth: 230,
              minHeight: 230,
              borderRadius: "50%",
              border: "none",
              boxShadow: speaking
                ? "0 0 26px rgba(99,102,241,0.35), 0 10px 24px rgba(0,0,0,0.28)"
                : "0 10px 22px rgba(0,0,0,0.2)",
              animation: "ij-ai-avatar-float 2s ease-in-out infinite",
              overflow: "hidden",
              background: "transparent",
              position: "relative",
            }}
          >
            <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
              {ringDots.map(({ idx, angle }) => {
                const strength = speaking ? i : i * 0.35;
                const pulse = Math.sin(Date.now() / 220 + idx * 0.55);
                const compress = 1 - strength * 0.18 + ((pulse + 1) / 2) * strength * 0.22;
                const radius = 136 + (speaking ? pulse * 16 : pulse * 8);
                const x = Math.cos(angle) * radius;
                const y = Math.sin(angle) * radius * compress;
                const size = 8 + strength * 8 + ((pulse + 1) / 2) * 3;
                const color = speaking
                  ? idx % 2 === 0
                    ? "rgba(56,189,248,0.95)"
                    : "rgba(129,140,248,0.95)"
                  : "rgba(148,163,184,0.8)";
                return (
                  <span
                    key={idx}
                    style={{
                      position: "absolute",
                      left: "50%",
                      top: "50%",
                      width: size,
                      height: size,
                      borderRadius: "50%",
                      background: color,
                      transform: `translate(${x}px, ${y}px)`,
                      boxShadow: speaking ? `0 0 10px ${color}` : "none",
                    }}
                  />
                );
              })}
            </div>
            <div
              style={{
                width: "100%",
                height: "100%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                position: "relative",
                zIndex: 2,
              }}
            >
              <AnimatedAgentFace intensity={i} speaking={speaking} />
            </div>
          </div>
          <span
            style={{
              fontSize: "0.78rem",
              fontWeight: 700,
              letterSpacing: "0.06em",
              color: speaking ? "#c7d2fe" : "#e2e8f0",
              textTransform: "uppercase",
              textShadow: "0 2px 12px rgba(0,0,0,0.45)",
            }}
          >
            {speaking ? "AI speaking" : "AI listening"}
          </span>
        </div>

        {/* Speaking glow */}
        {speaking && (
          <div
            style={{
              position: "absolute",
              inset: -40,
              background:
                "radial-gradient(circle at 50% 30%, rgba(99,102,241,0.32) 0%, transparent 60%)",
              filter: "blur(18px)",
              animation: "ij-boat-glow 1.1s ease-in-out infinite",
              zIndex: 1,
            }}
          />
        )}
      </div>
    </div>
  );
}

function AnimatedAgentFace({ intensity, speaking }) {
  const headTilt = (speaking ? 1 : 0.4) * (intensity * 8);
  const mouthOpen = 3 + intensity * 20;
  const mouthWidth = 24 + intensity * 16;
  const eyeLift = intensity * 1.8;
  const blink = (Math.sin(Date.now() / 420) + 1) / 2;
  const eyeOpen = blink > 0.92 ? 0.8 : 4.8;
  const browRaise = speaking ? 2.4 + intensity * 3 : 1.2 + intensity * 1.8;

  return (
    <svg viewBox="0 0 200 200" width="84%" height="84%" role="img" aria-label="Animated AI face">
      <g transform={`translate(100 90) rotate(${headTilt}) translate(-100 -90)`}>
        <circle cx="100" cy="75" r="34" fill="#F1F5F9" />
        <path
          d={`M80 ${64 - browRaise} Q88 ${60 - browRaise} 96 ${64 - browRaise}`}
          stroke="#0F172A"
          strokeOpacity="0.75"
          strokeWidth="2.6"
          strokeLinecap="round"
          fill="none"
        />
        <path
          d={`M104 ${64 - browRaise * 0.9} Q112 ${60 - browRaise * 0.9} 120 ${64 - browRaise * 0.9}`}
          stroke="#0F172A"
          strokeOpacity="0.75"
          strokeWidth="2.6"
          strokeLinecap="round"
          fill="none"
        />
        <ellipse cx="88" cy={72 - eyeLift} rx="4.4" ry={eyeOpen} fill="#0F172A" />
        <ellipse cx="112" cy={72 + eyeLift / 2} rx="4.4" ry={eyeOpen} fill="#0F172A" />
        <rect
          x={100 - mouthWidth / 2}
          y="90"
          width={mouthWidth}
          height={mouthOpen}
          rx="4"
          fill="#0F172A"
          fillOpacity="0.85"
        />
      </g>
      <path
        d="M58 145C58 119 79 98 105 98H95C121 98 142 119 142 145V150C142 155 138 159 133 159H67C62 159 58 155 58 150V145Z"
        fill="#CBD5E1"
      />
    </svg>
  );
}


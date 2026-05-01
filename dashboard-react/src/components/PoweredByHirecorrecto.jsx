import logo from "../Main_Logo.svg";

/**
 * Brand footer: "Powered by" + Hirecorrecto wordmark (Main_Logo.svg).
 */
export default function PoweredByHirecorrecto({ style, compact = false }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: compact ? 8 : 10,
        flexWrap: "wrap",
        ...style,
      }}
    >
      <span
        style={{
          fontSize: compact ? 11 : 12,
          fontWeight: 500,
          color: "rgba(148, 163, 184, 0.95)",
          letterSpacing: "0.04em",
          textTransform: "uppercase",
        }}
      >
        Powered by
      </span>
      <img
        src={logo}
        alt="Hirecorrecto"
        style={{
          height: compact ? 20 : 26,
          width: "auto",
          display: "block",
          objectFit: "contain",
        }}
      />
    </div>
  );
}

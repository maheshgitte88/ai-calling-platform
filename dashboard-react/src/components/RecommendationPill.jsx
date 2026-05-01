/** Colored pill for evaluation recommendation (shortlist / hold / reject). */

const pillBase = {
  fontSize: "0.75rem",
  fontWeight: 600,
  padding: "4px 10px",
  borderRadius: 999,
  display: "inline-block",
};

export function formatRecommendationLabel(raw) {
  if (raw == null || raw === "") return "—";
  const s = String(raw).trim();
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

export default function RecommendationPill({ value }) {
  const s = (value || "").toLowerCase().trim();
  let bg = "rgba(100,116,139,0.15)";
  let color = "#475569";
  if (s === "shortlist") {
    bg = "rgba(34,197,94,0.15)";
    color = "#15803d";
  } else if (s === "hold") {
    bg = "rgba(234,179,8,0.15)";
    color = "#a16207";
  } else if (s === "reject") {
    bg = "rgba(239,68,68,0.12)";
    color = "#b91c1c";
  }
  return (
    <span style={{ ...pillBase, background: bg, color, textTransform: "none" }}>
      {formatRecommendationLabel(value)}
    </span>
  );
}

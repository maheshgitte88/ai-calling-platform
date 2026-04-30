/**
 * Reusable provider selector with pricing, dynamic models, and optional voice selection.
 * Supports models as [{id, name}] or [string]. Voices as [{id, name}] when available.
 */
export default function ProviderSelector({
  label,
  providers,
  value,
  onChange,
  models = [],
  modelValue,
  onModelChange,
  voices = [],
  voiceValue,
  onVoiceChange,
  voicePlaceholder,
  apiKey,
  onApiKeyChange,
  extraFields = null,
}) {
  const current = providers?.find((p) => p.id === value) || {};
  const modelList = models?.length ? models : (current.models || []);
  const voiceList = voices?.length ? voices : (current.voices || []);

  const modelId = (m) => (typeof m === "string" ? m : m?.id);
  const modelLabel = (m) => (typeof m === "string" ? m : m?.name ?? m?.id);

  return (
    <div style={styles.block}>
      <label style={styles.label}>{label}</label>
      <select value={value} onChange={(e) => onChange(e.target.value)} style={styles.select}>
        <option value="">Select {label}</option>
        {providers?.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
            {p.pricePerMin != null && ` ($${p.pricePerMin}/min)`}
            {p.priceUnit && ` · ${p.priceUnit}`}
          </option>
        ))}
      </select>

      {modelList?.length > 0 && (
        <select
          value={modelValue ?? modelId(modelList[0])}
          onChange={(e) => onModelChange?.(e.target.value)}
          style={{ ...styles.select, marginTop: 8 }}
        >
          {modelList.map((m) => (
            <option key={modelId(m)} value={modelId(m)}>
              {modelLabel(m)}
            </option>
          ))}
        </select>
      )}

      {voiceList?.length > 0 ? (
        <select
          value={voiceValue ?? voiceList[0]?.id ?? ""}
          onChange={(e) => onVoiceChange?.(e.target.value)}
          style={{ ...styles.select, marginTop: 8 }}
        >
          {voiceList.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name || v.id}
            </option>
          ))}
        </select>
      ) : (
        voicePlaceholder !== false && (
          <input
            placeholder={voicePlaceholder || "Voice (name or ID)"}
            value={voiceValue ?? ""}
            onChange={(e) => onVoiceChange?.(e.target.value)}
            style={{ ...styles.select, marginTop: 8 }}
          />
        )
      )}

      {apiKey !== undefined && (
        <input
          type="password"
          placeholder="API Key"
          value={apiKey}
          onChange={(e) => onApiKeyChange?.(e.target.value)}
          style={{ ...styles.select, marginTop: 8 }}
        />
      )}
      {current.voiceHint && (
        <span style={styles.hint}>{current.voiceHint}</span>
      )}
      {extraFields}
    </div>
  );
}

const styles = {
  block: { marginBottom: "1.25rem" },
  label: { display: "block", marginBottom: 4, fontWeight: 500, fontSize: "0.9rem" },
  select: {
    width: "100%",
    padding: "0.5rem 0.75rem",
    borderRadius: 6,
    border: "1px solid #cbd5e1",
    fontSize: "0.9rem",
  },
  hint: { display: "block", fontSize: "0.75rem", color: "#64748b", marginTop: 4 },
};

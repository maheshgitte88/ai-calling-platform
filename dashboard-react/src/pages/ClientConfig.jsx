import { useState, useEffect } from "react";
import { useParams } from "react-router-dom";
import { api } from "../services/api";
import ProviderSelector from "../components/ProviderSelector";

export default function ClientConfig() {
  const { clientId } = useParams();
  const [client, setClient] = useState(null);
  const [providers, setProviders] = useState({});
  const [config, setConfig] = useState({
    llm: { provider: "gemini", apiKey: "", model: "gemini-2.5-flash" },
    stt: { provider: "deepgram", apiKey: "", model: "nova-3" },
    tts: { provider: "inworld", apiKey: "", voice: "Arjun", model: "inworld-tts-1.5-mini" },
    sip: { provider: "vobiz", trunkId: "", fromNumber: "" },
    rateLimit: 100,
    concurrencyLimit: 5,
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.getClient(clientId).then(setClient);
    api.getProviders().then(setProviders);
    api.getClientConfig(clientId).catch(() => {}).then((c) => {
      if (c?.llm) setConfig((prev) => ({ ...prev, ...c }));
    });
  }, [clientId]);

  const save = async () => {
    setSaving(true);
    try {
      await api.saveClientConfig(clientId, config);
      alert("Config saved");
    } finally {
      setSaving(false);
    }
  };

  if (!client) return <div>Loading...</div>;

  const llmProvider = providers.llm?.find((p) => p.id === config.llm.provider);
  const sttProvider = providers.stt?.find((p) => p.id === config.stt.provider);
  const ttsProvider = providers.tts?.find((p) => p.id === config.tts.provider);

  return (
    <div>
      <h1 style={{ marginBottom: "1.5rem" }}>Config: {client.name}</h1>

      <div style={styles.section}>
        <h3 style={styles.sectionTitle}>LLM</h3>
        <ProviderSelector
          label="LLM Provider"
          providers={providers.llm}
          value={config.llm.provider}
          onChange={(v) =>
            setConfig((c) => ({
              ...c,
              llm: {
                ...c.llm,
                provider: v,
                model: providers.llm?.find((p) => p.id === v)?.models?.[0]?.id ?? c.llm.model,
              },
            }))
          }
          models={llmProvider?.models}
          modelValue={config.llm.model}
          onModelChange={(v) => setConfig((c) => ({ ...c, llm: { ...c.llm, model: v } }))}
          apiKey={config.llm.apiKey}
          onApiKeyChange={(v) => setConfig((c) => ({ ...c, llm: { ...c.llm, apiKey: v } }))}
          voicePlaceholder={false}
        />
      </div>

      <div style={styles.section}>
        <h3 style={styles.sectionTitle}>STT</h3>
        <ProviderSelector
          label="STT Provider"
          providers={providers.stt}
          value={config.stt.provider}
          onChange={(v) =>
            setConfig((c) => ({
              ...c,
              stt: {
                ...c.stt,
                provider: v,
                model: providers.stt?.find((p) => p.id === v)?.models?.[0]?.id ?? c.stt.model,
              },
            }))
          }
          models={sttProvider?.models}
          modelValue={config.stt.model}
          onModelChange={(v) => setConfig((c) => ({ ...c, stt: { ...c.stt, model: v } }))}
          apiKey={config.stt.apiKey}
          onApiKeyChange={(v) => setConfig((c) => ({ ...c, stt: { ...c.stt, apiKey: v } }))}
          voicePlaceholder={false}
          extraFields={
            config.stt.provider === "sarvam" && (
              <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
                <input
                  placeholder="Language (e.g. en-IN, hi-IN)"
                  value={config.stt.language ?? ""}
                  onChange={(e) => setConfig((c) => ({ ...c, stt: { ...c.stt, language: e.target.value } }))}
                  style={styles.input}
                />
                <select
                  value={config.stt.mode ?? "transcribe"}
                  onChange={(e) => setConfig((c) => ({ ...c, stt: { ...c.stt, mode: e.target.value } }))}
                  style={styles.input}
                >
                  {(sttProvider?.modes || [
                    { id: "transcribe", name: "Transcribe" },
                    { id: "translate", name: "Translate" },
                    { id: "verbatim", name: "Verbatim" },
                    { id: "translit", name: "Translit" },
                    { id: "codemix", name: "Codemix" },
                  ]).map((m) => (
                    <option key={m.id} value={m.id}>{m.name}</option>
                  ))}
                </select>
              </div>
            )
          }
        />
      </div>

      <div style={styles.section}>
        <h3 style={styles.sectionTitle}>TTS</h3>
        <ProviderSelector
          label="TTS Provider"
          providers={providers.tts}
          value={config.tts.provider}
          onChange={(v) =>
            setConfig((c) => ({
              ...c,
              tts: {
                ...c.tts,
                provider: v,
                model: providers.tts?.find((p) => p.id === v)?.models?.[0]?.id ?? c.tts.model,
                voice: providers.tts?.find((p) => p.id === v)?.voices?.[0]?.id ?? c.tts.voice,
              },
            }))
          }
          models={ttsProvider?.models}
          modelValue={config.tts.model}
          onModelChange={(v) => setConfig((c) => ({ ...c, tts: { ...c.tts, model: v } }))}
          voices={ttsProvider?.voices}
          voiceValue={config.tts.voice}
          onVoiceChange={(v) => setConfig((c) => ({ ...c, tts: { ...c.tts, voice: v } }))}
          apiKey={config.tts.apiKey}
          onApiKeyChange={(v) => setConfig((c) => ({ ...c, tts: { ...c.tts, apiKey: v } }))}
          extraFields={
            config.tts.provider === "sarvam" && (
              <div style={{ marginTop: 8 }}>
                <input
                  placeholder="Target language (e.g. hi-IN, en-IN)"
                  value={config.tts.targetLanguageCode ?? ""}
                  onChange={(e) => setConfig((c) => ({ ...c, tts: { ...c.tts, targetLanguageCode: e.target.value } }))}
                  style={styles.input}
                />
              </div>
            ) ||
            config.tts.provider === "xai" && (
              <div style={{ marginTop: 8 }}>
                <input
                  placeholder="Language (auto, en, hi, zh, etc.)"
                  value={config.tts.targetLanguageCode ?? "auto"}
                  onChange={(e) => setConfig((c) => ({ ...c, tts: { ...c.tts, targetLanguageCode: e.target.value } }))}
                  style={styles.input}
                />
              </div>
            )
          }
        />
      </div>

      <div style={styles.section}>
        <h3 style={styles.sectionTitle}>SIP</h3>
        <ProviderSelector
          label="SIP Provider"
          providers={providers.sip}
          value={config.sip.provider}
          onChange={(v) => setConfig((c) => ({ ...c, sip: { ...c.sip, provider: v } }))}
          voicePlaceholder={false}
        />
        <input
          placeholder="Trunk ID"
          value={config.sip.trunkId}
          onChange={(e) => setConfig((c) => ({ ...c, sip: { ...c.sip, trunkId: e.target.value } }))}
          style={styles.input}
        />
        <input
          placeholder="From number (caller ID)"
          value={config.sip.fromNumber}
          onChange={(e) => setConfig((c) => ({ ...c, sip: { ...c.sip, fromNumber: e.target.value } }))}
          style={styles.input}
        />
      </div>

      <div style={styles.section}>
        <label>Concurrency limit</label>
        <input
          type="number"
          value={config.concurrencyLimit}
          onChange={(e) => setConfig((c) => ({ ...c, concurrencyLimit: +e.target.value }))}
          style={styles.input}
        />
      </div>

      <button onClick={save} disabled={saving} style={styles.btn}>
        {saving ? "Saving..." : "Save Config"}
      </button>
    </div>
  );
}

const styles = {
  section: { marginBottom: "1.5rem", maxWidth: 400 },
  sectionTitle: { marginBottom: 8, fontSize: "1rem" },
  input: {
    width: "100%",
    padding: "0.5rem 0.75rem",
    marginTop: 4,
    borderRadius: 6,
    border: "1px solid #cbd5e1",
  },
  btn: {
    padding: "0.6rem 1.2rem",
    borderRadius: 6,
    border: "none",
    background: "#0f172a",
    color: "#fff",
    cursor: "pointer",
  },
};

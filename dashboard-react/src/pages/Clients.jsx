import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { api } from "../services/api";
import { Settings, Pencil } from "lucide-react";

const DEFAULT_EXTRACTION = `{
  "current_salary": "Current CTC in lakhs if disclosed",
  "expected_salary": "Expected salary in lakhs if mentioned",
  "notice_period_days": "Notice period in days or 'serving notice'",
  "interested": "yes/no - candidate interest",
  "recommended_action": "callback_scheduled / not_eligible / follow_up / rejected"
}`;

export default function Clients() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [statsByClient, setStatsByClient] = useState({});
  const [openStatsClientId, setOpenStatsClientId] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({
    name: "",
    systemPrompt: "",
    summaryPrompt: "",
    extractionSchema: "{}",
  });

  useEffect(() => {
    api.getClients().then((r) => setItems(r.items || [])).finally(() => setLoading(false));
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    let extractionSchema = {};
    try {
      extractionSchema = JSON.parse(form.extractionSchema || "{}");
    } catch {
      alert("Extraction schema must be valid JSON");
      return;
    }
    await api.createClient({ ...form, extractionSchema });
    setForm({ name: "", systemPrompt: "", summaryPrompt: "", extractionSchema: "{}" });
    setShowForm(false);
    const r = await api.getClients();
    setItems(r.items || []);
  };

  const openEdit = (c) => {
    setEditing(c);
    setForm({
      name: c.name,
      systemPrompt: c.system_prompt || "",
      summaryPrompt: c.summary_prompt || "",
      extractionSchema: JSON.stringify(c.extraction_schema || {}, null, 2),
    });
  };

  const toggleClientStats = async (clientId) => {
    if (openStatsClientId === clientId) {
      setOpenStatsClientId(null);
      return;
    }
    if (!statsByClient[clientId]) {
      try {
        const stats = await api.getClientStats(clientId);
        setStatsByClient((prev) => ({ ...prev, [clientId]: stats }));
      } catch (e) {
        alert(e.message || "Unable to load client stats");
        return;
      }
    }
    setOpenStatsClientId(clientId);
  };

  const submitEdit = async (e) => {
    e.preventDefault();
    let extractionSchema = {};
    try {
      extractionSchema = JSON.parse(form.extractionSchema || "{}");
    } catch {
      alert("Extraction schema must be valid JSON");
      return;
    }
    await api.updateClient(editing.id, { ...form, extractionSchema });
    setEditing(null);
    const r = await api.getClients();
    setItems(r.items || []);
  };

  if (loading) return <div>Loading...</div>;

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" }}>
        <h1 style={{ fontSize: "1.5rem" }}>Clients</h1>
        <button onClick={() => setShowForm(!showForm)} style={styles.btn}>
          {showForm ? "Cancel" : "Add Client"}
        </button>
      </div>

      {showForm && (
        <form onSubmit={submit} style={styles.form}>
          <input
            placeholder="Client name"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
            style={styles.input}
          />
          <textarea
            placeholder="System prompt"
            value={form.systemPrompt}
            onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
            required
            rows={4}
            style={styles.input}
          />
          <textarea
            placeholder="Summary prompt (optional)"
            value={form.summaryPrompt}
            onChange={(e) => setForm({ ...form, summaryPrompt: e.target.value })}
            rows={2}
            style={styles.input}
          />
          <div>
            <label style={styles.label}>Extraction schema (JSON) – field names → descriptions for post-call extraction</label>
            <textarea
              placeholder='{"field_name": "description", ...}'
              value={form.extractionSchema || "{}"}
              onChange={(e) => setForm({ ...form, extractionSchema: e.target.value })}
              rows={8}
              style={{ ...styles.input, fontFamily: "monospace", fontSize: "0.85rem" }}
            />
            <button type="button" onClick={() => setForm({ ...form, extractionSchema: DEFAULT_EXTRACTION })} style={styles.linkBtn}>
              Use example template
            </button>
          </div>
          <button type="submit" style={styles.btnPrimary}>
            Create
          </button>
        </form>
      )}

      {editing && (
        <div style={styles.modal}>
          <div style={styles.modalContent}>
            <h3>Edit client</h3>
            <form onSubmit={submitEdit} style={styles.form}>
              <input
                placeholder="Client name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
                style={styles.input}
              />
              <textarea
                placeholder="System prompt"
                value={form.systemPrompt}
                onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
                required
                rows={4}
                style={styles.input}
              />
              <textarea
                placeholder="Summary prompt"
                value={form.summaryPrompt}
                onChange={(e) => setForm({ ...form, summaryPrompt: e.target.value })}
                rows={2}
                style={styles.input}
              />
              <div>
                <label style={styles.label}>Extraction schema (JSON)</label>
                <textarea
                  value={form.extractionSchema}
                  onChange={(e) => setForm({ ...form, extractionSchema: e.target.value })}
                  rows={8}
                  style={{ ...styles.input, fontFamily: "monospace", fontSize: "0.85rem" }}
                />
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button type="submit" style={styles.btnPrimary}>Save</button>
                <button type="button" onClick={() => setEditing(null)} style={styles.btn}>Cancel</button>
              </div>
            </form>
          </div>
        </div>
      )}

      <div style={styles.grid}>
        {items.map((c) => (
          <div key={c.id} style={styles.card}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <h3 style={{ fontSize: "1.1rem" }}>{c.name}</h3>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <button onClick={() => openEdit(c)} style={styles.iconBtn} title="Edit">
                  <Pencil size={16} />
                </button>
                <Link to={`/clients/${c.id}/config`} style={styles.iconLink}>
                  <Settings size={18} />
                  Config
                </Link>
              </div>
            </div>
            <p style={{ fontSize: "0.85rem", color: "#64748b", marginTop: 4, maxHeight: 60, overflow: "hidden" }}>
              {c.system_prompt?.slice(0, 100)}...
            </p>
            <button onClick={() => toggleClientStats(c.id)} style={styles.linkBtn}>
              {openStatsClientId === c.id ? "Hide call dashboard" : "Show client dashboard"}
            </button>
            {openStatsClientId === c.id && (
              <div style={styles.statsBox}>
                <div style={styles.statsRow}><span>Total Calls:</span><strong>{statsByClient[c.id]?.total ?? 0}</strong></div>
                <div style={styles.statsRow}><span>Completed:</span><strong>{statsByClient[c.id]?.completed ?? 0}</strong></div>
                <div style={styles.statsRow}><span>In Progress:</span><strong>{statsByClient[c.id]?.in_progress ?? 0}</strong></div>
                <div style={styles.statsRow}><span>Dispatched:</span><strong>{statsByClient[c.id]?.dispatched ?? 0}</strong></div>
                <div style={styles.statsRow}><span>Queued:</span><strong>{statsByClient[c.id]?.queued ?? 0}</strong></div>
                <div style={styles.statsRow}><span>Failed:</span><strong>{statsByClient[c.id]?.failed ?? 0}</strong></div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

const styles = {
  form: { marginBottom: "1.5rem", maxWidth: 500 },
  label: { display: "block", marginBottom: 4, fontWeight: 500, fontSize: "0.9rem" },
  linkBtn: { background: "none", border: "none", color: "#3b82f6", cursor: "pointer", fontSize: "0.85rem", marginTop: 4 },
  modal: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 },
  modalContent: { background: "#fff", padding: "1.5rem", borderRadius: 8, maxWidth: 540, maxHeight: "90vh", overflow: "auto" },
  iconBtn: { background: "none", border: "none", cursor: "pointer", padding: 4, color: "#64748b" },
  input: {
    width: "100%",
    padding: "0.5rem 0.75rem",
    marginBottom: 8,
    borderRadius: 6,
    border: "1px solid #cbd5e1",
  },
  btn: {
    padding: "0.5rem 1rem",
    borderRadius: 6,
    border: "1px solid #cbd5e1",
    background: "#fff",
    cursor: "pointer",
  },
  btnPrimary: {
    padding: "0.5rem 1rem",
    borderRadius: 6,
    border: "none",
    background: "#0f172a",
    color: "#fff",
    cursor: "pointer",
  },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: "1rem" },
  card: {
    background: "#fff",
    padding: "1.25rem",
    borderRadius: 8,
    border: "1px solid #e2e8f0",
  },
  iconLink: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    color: "#3b82f6",
    textDecoration: "none",
    fontSize: "0.85rem",
  },
  statsBox: {
    marginTop: 8,
    border: "1px solid #e2e8f0",
    borderRadius: 6,
    background: "#f8fafc",
    padding: 8,
    fontSize: "0.85rem",
  },
  statsRow: {
    display: "flex",
    justifyContent: "space-between",
    padding: "2px 0",
  },
};

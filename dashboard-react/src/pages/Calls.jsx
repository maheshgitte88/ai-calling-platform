import { useState, useEffect } from "react";
import { api } from "../services/api";
import { Phone, ChevronDown } from "lucide-react";

export default function Calls() {
  const [items, setItems] = useState([]);
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [clientFilter, setClientFilter] = useState("");
  const [showBulk, setShowBulk] = useState(false);
  const [selectedCalls, setSelectedCalls] = useState({});
  const [redialing, setRedialing] = useState(false);
  const [form, setForm] = useState({ clientId: "", phone: "", name: "" });
  const [bulkForm, setBulkForm] = useState({ clientId: "", contacts: "" });

  const load = () => {
    api.getCalls(clientFilter ? { clientId: clientFilter } : {}).then((r) => setItems(r.items || []));
  };

  useEffect(() => {
    Promise.all([api.getCalls(), api.getClients()]).then(([c, cl]) => {
      setItems(c.items || []);
      setClients(cl.items || []);
    }).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (clientFilter !== undefined) load();
  }, [clientFilter]);

  const startCall = async (e) => {
    e.preventDefault();
    await api.createCall(form);
    setForm({ ...form, phone: "" });
    load();
  };

  const startBulk = async (e) => {
    e.preventDefault();
    const contacts = bulkForm.contacts
      .split("\n")
      .map((line) => {
        const [phone, name] = line.split(/[,\t]/).map((s) => s.trim());
        return phone ? { phone, name: name || undefined } : null;
      })
      .filter(Boolean);
    await api.createBulkCalls({ clientId: bulkForm.clientId, contacts });
    setBulkForm({ ...bulkForm, contacts: "" });
    setShowBulk(false);
    load();
  };

  const keyExtractedFields = getKeyExtractedFields(items, clients, clientFilter, 3);
  const selectedCallItems = items.filter((c) => selectedCalls[c.id]);

  const toggleCallSelection = (id) =>
    setSelectedCalls((prev) => ({ ...prev, [id]: !prev[id] }));

  const toggleSelectAllVisible = () => {
    const allSelected = items.length > 0 && items.every((c) => selectedCalls[c.id]);
    if (allSelected) {
      const next = { ...selectedCalls };
      items.forEach((c) => delete next[c.id]);
      setSelectedCalls(next);
      return;
    }
    const next = { ...selectedCalls };
    items.forEach((c) => {
      next[c.id] = true;
    });
    setSelectedCalls(next);
  };

  const redialSelected = async () => {
    if (selectedCallItems.length === 0) return;
    setRedialing(true);
    try {
      const groups = selectedCallItems.reduce((acc, call) => {
        if (!acc[call.client_id]) acc[call.client_id] = [];
        acc[call.client_id].push({
          phone: call.phone,
          name: call.metadata?.name || undefined,
        });
        return acc;
      }, {});
      for (const [clientId, contacts] of Object.entries(groups)) {
        await api.createBulkCalls({ clientId, contacts });
      }
      setSelectedCalls({});
      await load();
    } catch (e) {
      alert(e.message || "Redial failed");
    } finally {
      setRedialing(false);
    }
  };

  const deleteOne = async (call) => {
    if (!["queued", "dispatched"].includes(call.status)) return;
    const ok = window.confirm(`Delete call ${call.phone} (${call.status})?`);
    if (!ok) return;
    try {
      await api.deleteCall(call.id);
      if (selected === call.id) setSelected(null);
      setSelectedCalls((prev) => {
        const next = { ...prev };
        delete next[call.id];
        return next;
      });
      await load();
    } catch (e) {
      alert(e.message || "Delete failed");
    }
  };

  const deleteSelected = async () => {
    const deletable = selectedCallItems.filter((c) => ["queued", "dispatched"].includes(c.status));
    if (deletable.length === 0) {
      alert("Select queued/dispatched calls to delete.");
      return;
    }
    const ok = window.confirm(`Delete ${deletable.length} queued/dispatched call(s)?`);
    if (!ok) return;
    try {
      for (const c of deletable) {
        await api.deleteCall(c.id);
      }
      setSelected(null);
      setSelectedCalls({});
      await load();
    } catch (e) {
      alert(e.message || "Bulk delete failed");
    }
  };

  const downloadReport = (format = "csv") => {
    const rows = items;
    const extractedKeys = getAllExtractedKeys(rows, clients, clientFilter);
    const headers = ["mobile_number", "name", "call_status", "client", ...extractedKeys];
    const matrix = rows.map((c) => {
      const extracted = c.extracted_fields || {};
      return [
        c.phone || "",
        c.metadata?.name || "",
        c.status || "",
        clients.find((x) => x.id === c.client_id)?.name || c.client_id || "",
        ...extractedKeys.map((k) => normalizeFieldValue(extracted[k])),
      ];
    });
    const delimiter = format === "csv" ? "," : "\t";
    const ext = format === "csv" ? "csv" : "xls";
    const mime =
      format === "csv"
        ? "text/csv;charset=utf-8;"
        : "application/vnd.ms-excel;charset=utf-8;";
    const content = [headers, ...matrix]
      .map((row) => row.map((v) => quoteCell(v, delimiter)).join(delimiter))
      .join("\n");
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const clientName =
      clients.find((c) => c.id === clientFilter)?.name?.replace(/\s+/g, "-").toLowerCase() || "all-clients";
    a.href = url;
    a.download = `calls-report-${clientName}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  if (loading) return <div>Loading...</div>;

  return (
    <div>
      <h1 style={{ marginBottom: "1.5rem" }}>Calls</h1>

      <div style={{ display: "flex", gap: 16, marginBottom: "1.5rem", flexWrap: "wrap" }}>
        <select
          value={clientFilter}
          onChange={(e) => setClientFilter(e.target.value)}
          style={styles.select}
        >
          <option value="">All clients</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <form onSubmit={startCall} style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <select
            value={form.clientId}
            onChange={(e) => setForm({ ...form, clientId: e.target.value })}
            required
            style={styles.select}
          >
            <option value="">Client</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <input
            placeholder="Phone"
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
            style={styles.input}
          />
          <input
            placeholder="Name (optional)"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            style={styles.input}
          />
          <button type="submit" style={styles.btn}>
            <Phone size={16} />
            Call
          </button>
        </form>
        <button onClick={() => setShowBulk(!showBulk)} style={styles.btnSecondary}>
          Bulk calls
        </button>
        <button onClick={() => downloadReport("csv")} style={styles.btnSecondary}>
          Download CSV
        </button>
        <button onClick={() => downloadReport("excel")} style={styles.btnSecondary}>
          Download Excel
        </button>
        <button
          onClick={redialSelected}
          style={styles.btn}
          disabled={selectedCallItems.length === 0 || redialing}
        >
          {redialing ? "Redialing..." : `Redial selected (${selectedCallItems.length})`}
        </button>
        <button
          onClick={deleteSelected}
          style={styles.btnSecondary}
          disabled={selectedCallItems.filter((c) => ["queued", "dispatched"].includes(c.status)).length === 0}
        >
          Delete selected (queued/dispatched)
        </button>
      </div>

      {showBulk && (
        <form onSubmit={startBulk} style={styles.bulkForm}>
          <select
            value={bulkForm.clientId}
            onChange={(e) => setBulkForm({ ...bulkForm, clientId: e.target.value })}
            required
            style={styles.select}
          >
            <option value="">Client</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <textarea
            placeholder="One per line: phone or phone,name"
            value={bulkForm.contacts}
            onChange={(e) => setBulkForm({ ...bulkForm, contacts: e.target.value })}
            rows={6}
            style={styles.input}
          />
          <button type="submit" style={styles.btn}>Start bulk</button>
        </form>
      )}

      <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>
                <input
                  type="checkbox"
                  checked={items.length > 0 && items.every((c) => selectedCalls[c.id])}
                  onChange={toggleSelectAllVisible}
                />
              </th>
              <th style={styles.th}>Phone</th>
              <th style={styles.th}>Status</th>
              <th style={styles.th}>Client</th>
              {keyExtractedFields.map((field) => (
                <th key={field} style={styles.th}>{prettyFieldName(field)}</th>
              ))}
              <th style={styles.th}>Created</th>
              <th style={styles.th}></th>
            </tr>
          </thead>
          <tbody>
            {items.map((c) => (
              <tr key={c.id} style={styles.tr}>
                <td style={styles.td}>
                  <input
                    type="checkbox"
                    checked={!!selectedCalls[c.id]}
                    onChange={() => toggleCallSelection(c.id)}
                  />
                </td>
                <td style={styles.td}>{c.phone}</td>
                <td style={styles.td}>
                  <span style={statusStyle(c.status)}>{c.status}</span>
                </td>
                <td style={styles.td}>{clients.find((x) => x.id === c.client_id)?.name || c.client_id}</td>
                {keyExtractedFields.map((field) => (
                  <td key={`${c.id}-${field}`} style={styles.td}>
                    {normalizeFieldValue(c.extracted_fields?.[field]) || "-"}
                  </td>
                ))}
                <td style={styles.td}>{new Date(c.created_at).toLocaleString()}</td>
                <td style={styles.td}>
                  <button
                    onClick={() => setSelected(selected === c.id ? null : c.id)}
                    style={styles.smallBtn}
                  >
                    <ChevronDown size={14} />
                  </button>
                  {["queued", "dispatched"].includes(c.status) && (
                    <button onClick={() => deleteOne(c)} style={styles.deleteBtn}>
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selected && (
        <CallDetail id={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

function CallDetail({ id, onClose }) {
  const [detail, setDetail] = useState(null);
  const [recovering, setRecovering] = useState(false);
  const load = () => api.getCall(id).then(setDetail);
  useEffect(() => { load(); }, [id]);

  const needsRecovery =
    detail &&
    (detail.transcriptEntries?.length > 0) &&
    !detail.summary;

  const onRecover = async () => {
    setRecovering(true);
    try {
      await api.recoverCallSummary(id);
      await load();
    } catch (e) {
      alert(e.message || "Recovery failed");
    } finally {
      setRecovering(false);
    }
  };

  if (!detail) return null;
  return (
    <div style={styles.modal}>
      <div style={styles.modalContent}>
        <button onClick={onClose} style={styles.closeBtn}>
          ×
        </button>
        <h3>Call {detail.phone}</h3>
        <p>Status: {detail.status}</p>
        {needsRecovery && (
          <button onClick={onRecover} disabled={recovering} style={styles.btnSecondary}>
            {recovering ? "Recovering…" : "Recover summary"}
          </button>
        )}
        {detail.summary && <p><strong>Summary:</strong> {detail.summary}</p>}
        {detail.extracted_fields && Object.keys(detail.extracted_fields).length > 0 && (
          <div style={{ marginTop: 16 }}>
            <strong>Extracted Fields</strong>
            <div style={styles.extractedFields}>
              {Object.entries(detail.extracted_fields)
                .filter(([, v]) => v != null && v !== "")
                .map(([k, v]) => (
                  <div key={k} style={styles.extractedRow}>
                    <span style={styles.extractedKey}>{k.replace(/_/g, " ")}:</span>
                    <span>{String(v)}</span>
                  </div>
                ))}
            </div>
          </div>
        )}
        {detail.transcriptEntries?.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <strong>Transcript</strong>
            <pre style={styles.transcript}>
              {detail.transcriptEntries.map((e) => `[${e.role}] ${e.text}`).join("\n")}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

function statusStyle(s) {
  const colors = {
    queued: "#94a3b8",
    dispatched: "#3b82f6",
    "in-progress": "#f59e0b",
    completed: "#22c55e",
    failed: "#ef4444",
  };
  return { color: colors[s] || "#64748b" };
}

const styles = {
  select: { padding: "0.5rem", borderRadius: 6, border: "1px solid #cbd5e1" },
  input: { padding: "0.5rem", borderRadius: 6, border: "1px solid #cbd5e1", minWidth: 140 },
  btn: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "0.5rem 1rem",
    borderRadius: 6,
    border: "none",
    background: "#0f172a",
    color: "#fff",
    cursor: "pointer",
  },
  btnSecondary: {
    padding: "0.5rem 1rem",
    borderRadius: 6,
    border: "1px solid #cbd5e1",
    background: "#fff",
    cursor: "pointer",
  },
  bulkForm: { marginBottom: "1.5rem", display: "flex", flexDirection: "column", gap: 8, maxWidth: 500 },
  tableWrap: { background: "#fff", borderRadius: 8, border: "1px solid #e2e8f0", overflow: "auto" },
  table: { width: "100%", borderCollapse: "collapse" },
  th: { textAlign: "left", padding: "0.75rem", borderBottom: "1px solid #e2e8f0", fontWeight: 500 },
  tr: { borderBottom: "1px solid #f1f5f9" },
  td: { padding: "0.75rem" },
  smallBtn: { background: "none", border: "none", cursor: "pointer" },
  deleteBtn: {
    marginLeft: 8,
    padding: "0.25rem 0.5rem",
    borderRadius: 6,
    border: "1px solid #fecaca",
    color: "#b91c1c",
    background: "#fff",
    cursor: "pointer",
    fontSize: "0.8rem",
  },
  modal: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.4)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  modalContent: {
    background: "#fff",
    padding: "1.5rem",
    borderRadius: 8,
    maxWidth: 500,
    maxHeight: "80vh",
    overflow: "auto",
    position: "relative",
  },
  closeBtn: { position: "absolute", top: 8, right: 12, fontSize: "1.5rem", cursor: "pointer", background: "none", border: "none" },
  extractedFields: { marginTop: 8, padding: 12, background: "#f8fafc", borderRadius: 6, fontSize: "0.9rem" },
  extractedRow: { display: "flex", gap: 8, marginBottom: 4 },
  extractedKey: { fontWeight: 500, minWidth: 140, textTransform: "capitalize" },
  transcript: { whiteSpace: "pre-wrap", fontSize: "0.85rem", marginTop: 8, maxHeight: 200, overflow: "auto" },
};

function prettyFieldName(field) {
  return String(field || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

function normalizeFieldValue(value) {
  if (value == null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function getAllExtractedKeys(items, clients, clientFilter) {
  if (clientFilter) {
    const schema = clients.find((c) => c.id === clientFilter)?.extraction_schema || {};
    const schemaKeys = Object.keys(schema);
    if (schemaKeys.length > 0) return schemaKeys;
  }
  const keys = new Set();
  for (const item of items) {
    Object.keys(item.extracted_fields || {}).forEach((k) => keys.add(k));
  }
  return Array.from(keys);
}

function getKeyExtractedFields(items, clients, clientFilter, count = 3) {
  const keys = getAllExtractedKeys(items, clients, clientFilter);
  if (keys.length <= count) return keys;
  return keys.slice(0, count);
}

function quoteCell(value, delimiter) {
  const s = normalizeFieldValue(value);
  if (s.includes('"') || s.includes("\n") || s.includes("\r") || s.includes(delimiter)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

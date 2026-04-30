import { useState, useEffect, useRef } from "react";
import { api } from "../services/api";
import { Upload, Play, Download } from "lucide-react";

export default function Campaigns() {
  const [items, setItems] = useState([]);
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);
  const fileRef = useRef(null);

  useEffect(() => {
    Promise.all([api.getCampaigns(), api.getClients()]).then(([c, cl]) => {
      setItems(c.items || []);
      setClients(cl.items || []);
    }).finally(() => setLoading(false));
  }, []);

  const refreshCampaigns = async () => {
    const c = await api.getCampaigns();
    setItems(c.items || []);
  };

  const handleImport = async (e) => {
    e.preventDefault();
    const form = e.target;
    const fd = new FormData(form);
    const clientId = form.clientId.value;
    const campaignName = form.campaignName.value;
    if (!clientId || !campaignName || !fd.get("file")) {
      alert("Fill client, campaign name, and select file");
      return;
    }
    setImporting(true);
    try {
      const r = await api.importCampaign(fd);
      if (!r?.campaignId) {
        throw new Error("Campaign import failed: missing campaign ID");
      }
      await refreshCampaigns();
      form.reset();
    } catch (err) {
      alert(err.message || "Import failed");
    } finally {
      setImporting(false);
    }
  };

  const startCampaign = async (campaignId) => {
    if (!campaignId) {
      alert("Invalid campaign id. Please re-import and try again.");
      return;
    }
    try {
      const r = await api.startCampaign(campaignId);
      alert(`Dispatched: ${r.dispatched}, Failed: ${r.failed}`);
      await refreshCampaigns();
    } catch (err) {
      alert(err.message || "Unable to start campaign");
    }
  };

  const downloadTemplate = (format = "csv") => {
    const headers = ["phone", "name", "city", "notes"];
    const rows = [
      ["+919876543210", "Rahul Sharma", "Pune", "Interested in PGDM Marketing"],
      ["+918888724838", "Mahesh", "Mumbai", "Asked for callback tomorrow"],
    ];
    const delimiter = format === "csv" ? "," : "\t";
    const ext = format === "csv" ? "csv" : "xls";
    const mime =
      format === "csv"
        ? "text/csv;charset=utf-8;"
        : "application/vnd.ms-excel;charset=utf-8;";
    const content = [headers, ...rows]
      .map((row) => row.map((cell) => quoteCell(cell, delimiter)).join(delimiter))
      .join("\n");
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `campaign-template.${ext}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  if (loading) return <div>Loading...</div>;

  return (
    <div>
      <h1 style={{ marginBottom: "1.5rem" }}>Campaigns</h1>

      <form onSubmit={handleImport} style={styles.form}>
        <select name="clientId" required style={styles.select}>
          <option value="">Client</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <input name="campaignName" placeholder="Campaign name" required style={styles.input} />
        <input ref={fileRef} name="file" type="file" accept=".xlsx,.xls,.csv" style={styles.input} />
        <button type="submit" disabled={importing} style={styles.btn}>
          <Upload size={16} /> Import Excel/CSV
        </button>
        <button type="button" onClick={() => downloadTemplate("csv")} style={styles.btnSecondary}>
          <Download size={16} /> Example CSV
        </button>
        <button type="button" onClick={() => downloadTemplate("excel")} style={styles.btnSecondary}>
          <Download size={16} /> Example Excel
        </button>
      </form>

      <div style={styles.grid}>
        {items.map((c) => (
          <div key={c.id || c._id} style={styles.card}>
            <h3>{c.name}</h3>
            <p style={{ fontSize: "0.85rem", color: "#64748b" }}>
              {clients.find((x) => x.id === c.client_id)?.name} · {c.status}
            </p>
            {c.status === "draft" && (
              <button onClick={() => startCampaign(c.id)} style={styles.btn} disabled={!c.id}>
                <Play size={14} /> Start
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

const styles = {
  form: { display: "flex", gap: 12, marginBottom: "1.5rem", flexWrap: "wrap", alignItems: "center" },
  select: { padding: "0.5rem", borderRadius: 6, border: "1px solid #cbd5e1", minWidth: 150 },
  input: { padding: "0.5rem", borderRadius: 6, border: "1px solid #cbd5e1", minWidth: 120 },
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
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "0.5rem 1rem",
    borderRadius: 6,
    border: "1px solid #cbd5e1",
    background: "#fff",
    color: "#0f172a",
    cursor: "pointer",
  },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: "1rem" },
  card: {
    background: "#fff",
    padding: "1.25rem",
    borderRadius: 8,
    border: "1px solid #e2e8f0",
  },
};

function quoteCell(value, delimiter) {
  const text = String(value ?? "");
  if (text.includes('"') || text.includes("\n") || text.includes("\r") || text.includes(delimiter)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

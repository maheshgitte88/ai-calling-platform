import { useState } from "react";
import { api } from "../services/api";
import { Phone } from "lucide-react";

/**
 * Playground - test AI agent with a simulated call.
 * Creates a room, fetches token, and can connect via LiveKit (browser or mobile).
 * For full voice test, use LiveKit Meet or connect a client with the token.
 */
export default function Playground() {
  const [clients, setClients] = useState([]);
  const [clientId, setClientId] = useState("");
  const [roomName, setRoomName] = useState("");
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(false);

  const loadClients = async () => {
    const r = await api.getClients();
    setClients(r.items || []);
  };

  const createRoom = async () => {
    if (!roomName.trim()) {
      alert("Enter room name");
      return;
    }
    setLoading(true);
    try {
      const r = await api.getPlaygroundToken({
        roomName: roomName.trim(),
        participantName: "playground-user",
      });
      setToken(r.token);
    } catch (e) {
      alert(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <h1 style={{ marginBottom: "1.5rem" }}>Playground</h1>
      <p style={{ color: "#64748b", marginBottom: "1.5rem" }}>
        Create a test room and join with LiveKit Meet or any LiveKit client. The AI agent will join when dispatched.
      </p>

      <div style={styles.form}>
        <input
          placeholder="Room name (e.g. playground-test-1)"
          value={roomName}
          onChange={(e) => setRoomName(e.target.value)}
          style={styles.input}
        />
        <button onClick={createRoom} disabled={loading} style={styles.btn}>
          <Phone size={16} /> Create room & get token
        </button>
      </div>

      {token && (
        <div style={styles.tokenBox}>
          <label>Token (use in LiveKit client)</label>
          <textarea value={token} readOnly rows={4} style={styles.tokenInput} />
          <p style={{ fontSize: "0.85rem", color: "#64748b" }}>
            Room: {roomName} · Paste this token in LiveKit Meet or your client to join.
          </p>
        </div>
      )}

      <div style={{ marginTop: "2rem" }}>
        <button onClick={loadClients} style={styles.btnSecondary}>
          Load clients
        </button>
        {clients.length > 0 && (
          <select value={clientId} onChange={(e) => setClientId(e.target.value)} style={styles.select}>
            <option value="">Select client for config reference</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}

const styles = {
  form: { display: "flex", gap: 12, marginBottom: "1rem", flexWrap: "wrap" },
  input: { padding: "0.5rem 0.75rem", borderRadius: 6, border: "1px solid #cbd5e1", minWidth: 220 },
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
    marginRight: 8,
  },
  select: { padding: "0.5rem", borderRadius: 6, border: "1px solid #cbd5e1" },
  tokenBox: { marginTop: "1rem", maxWidth: 500 },
  tokenInput: {
    width: "100%",
    padding: "0.5rem",
    marginTop: 4,
    borderRadius: 6,
    border: "1px solid #cbd5e1",
    fontFamily: "monospace",
    fontSize: "0.8rem",
  },
};

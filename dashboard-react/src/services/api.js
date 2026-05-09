// Amplify / CDN: set VITE_API_BASE_URL to your API origin (e.g. https://ec2-or-domain). Empty = same origin /api.
const API_ORIGIN = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");
const API_BASE = API_ORIGIN ? `${API_ORIGIN}/api` : "/api";

async function request(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...options.headers },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

export const api = {
  startInterviewSession: (body) =>
    request("/interviews/session/start", { method: "POST", body: JSON.stringify(body) }),
  resolveInterviewSession: (body) =>
    request("/interviews/session/resolve", { method: "POST", body: JSON.stringify(body) }),
  endInterviewSession: (sessionId, body = {}) =>
    request(`/interviews/session/${sessionId}/end`, { method: "POST", body: JSON.stringify(body) }),
  getInterviewSession: (sessionId) =>
    request(`/interviews/session/${sessionId}`),
  addInterviewSessionEvent: (sessionId, body) =>
    request(`/interviews/session/${sessionId}/event`, { method: "POST", body: JSON.stringify(body) }),
  uploadInterviewProctorFrame: (sessionId, blob, meta = {}, { signal } = {}) => {
    const fd = new FormData();
    const filename = `proctor-${meta.capturedAt || new Date().toISOString()}.jpg`.replace(/[:.]/g, "-");
    fd.append("image", blob, filename);
    fd.append("meta", JSON.stringify(meta || {}));
    return fetch(`${API_BASE}/interviews/session/${sessionId}/proctor/frame`, {
      method: "POST",
      body: fd,
      signal,
    }).then(async (res) => {
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || res.statusText);
      return data;
    });
  },
  getInterviewSessions: (params) => {
    const sp = new URLSearchParams();
    if (params?.limit) sp.set("limit", String(params.limit));
    if (params?.status) sp.set("status", params.status);
    if (params?.candidateId) sp.set("candidateId", params.candidateId);
    if (params?.interviewId) sp.set("interviewId", params.interviewId);
    const qs = sp.toString();
    return request(`/interviews/sessions${qs ? `?${qs}` : ""}`);
  },
  getInterviewEvaluation: (sessionId) =>
    request(`/interviews/evaluations/${sessionId}`),
  evaluateInterviewSession: (sessionId) =>
    request(`/interviews/session/${sessionId}/evaluate`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
};

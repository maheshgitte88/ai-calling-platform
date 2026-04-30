const API_BASE = "/api";

async function request(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...options.headers },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

async function requestForm(path, formData) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    body: formData,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

export const api = {
  getProviders: () => request("/providers"),
  getClients: () => request("/clients"),
  getClient: (id) => request(`/clients/${id}`),
  getClientStats: (id) => request(`/clients/${id}/stats`),
  createClient: (body) => request("/clients", { method: "POST", body: JSON.stringify(body) }),
  updateClient: (id, body) => request(`/clients/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  getClientConfig: (clientId) => request(`/clients/${clientId}/config`),
  saveClientConfig: (clientId, body) =>
    request(`/clients/${clientId}/config`, { method: "POST", body: JSON.stringify(body) }),
  getCalls: (params) =>
    request(`/calls${params?.clientId ? `?clientId=${params.clientId}` : ""}`),
  getCall: (id) => request(`/calls/${id}`),
  deleteCall: (id) => request(`/calls/${id}`, { method: "DELETE" }),
  createCall: (body) => request("/calls", { method: "POST", body: JSON.stringify(body) }),
  createBulkCalls: (body) => request("/calls/bulk", { method: "POST", body: JSON.stringify(body) }),
  recoverCallSummary: (id) => request(`/calls/${id}/recover-summary`, { method: "POST" }),
  getCampaigns: (params) =>
    request(`/campaigns${params?.clientId ? `?clientId=${params.clientId}` : ""}`),
  importCampaign: (formData) => requestForm("/campaigns/import", formData),
  startCampaign: (campaignId) =>
    request(`/campaigns/${campaignId}/start`, { method: "POST" }),
  getPlaygroundToken: (body) =>
    request("/playground/token", { method: "POST", body: JSON.stringify(body) }),
};

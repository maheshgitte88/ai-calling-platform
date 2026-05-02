# AWS EC2 Deployment Guide (ai-calling-platform)

This runbook explains how to deploy the full application on a single AWS EC2 instance:

- `backend-node` (Node API)
- `dashboard-react` (React UI)
- `agent-python` (LiveKit interview/calling agents)
- MongoDB + Redis (local or managed)
- LiveKit transport (typically separate host; see `docs/LiveKitEC2.md`)

---

## 1) Reference architecture

- **EC2 instance**: runs Node API + Python agent + Nginx + (optional) Mongo/Redis
- **LiveKit server/SIP**: external/self-hosted (often separate EC2), reachable from API + agent
- **Public access**:
  - `https://your-domain` -> Nginx -> React static app
  - `https://your-domain/api/*` -> Nginx -> Node API `:4040`

---

## 2) Prerequisites

- Ubuntu 22.04+ EC2 instance
- DNS A record pointing to EC2 public IP
- Open ports in Security Group:
  - `22` (SSH) restricted to your IP
  - `80`, `443` public
  - `4040` private only (or closed; proxied via Nginx)
- Installed software:
  - Node.js 20+
  - Python 3.10+
  - Git
  - Nginx
  - Certbot
  - PM2 (or systemd for Node)

Install baseline packages:

```bash
sudo apt update
sudo apt install -y git nginx python3 python3-venv python3-pip certbot python3-certbot-nginx
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm i -g pm2
```

---

## 3) Clone repo and folders

```bash
cd /opt
sudo git clone <YOUR_REPO_URL> ai-calling-platform
sudo chown -R $USER:$USER /opt/ai-calling-platform
cd /opt/ai-calling-platform
```

---

## 4) Configure environment files

### 4.1 Backend env (`backend-node/.env`)

Minimum keys:

```env
LIVEKIT_URL=wss://<your-livekit-domain>
LIVEKIT_API_KEY=<key>
LIVEKIT_API_SECRET=<secret>
INTERVIEW_AGENT_NAME=ai-interview-agent
AGENT_NAME=ai-calling-agent
MONGODB_URI=mongodb://127.0.0.1:27017/ai_calling
REDIS_URL=redis://127.0.0.1:6379
PORT=4040
APP_BASE_URL=https://<your-domain>
INTERVIEW_JOIN_TOKEN_SECRET=<strong-random-secret>
```

### 4.2 Agent env (`agent-python/.env`)

Set LiveKit, Mongo, and provider API keys (OpenAI/Gemini/Deepgram/etc.).

Important:

- `INTERVIEW_AGENT_NAME` must match backend dispatch target
- Keep `MONGODB_URI` same DB as backend

---

## 5) Build and run backend

```bash
cd /opt/ai-calling-platform/backend-node
npm ci
pm2 start src/server.js --name ai-calling-backend
pm2 save
pm2 startup
```

Health check:

```bash
curl http://127.0.0.1:4040/health
```

---

## 6) Build and host dashboard (React)

```bash
cd /opt/ai-calling-platform/dashboard-react
npm ci
npm run build
```

Use Nginx to serve `dashboard-react/dist`.

---

## 7) Run Python agent as systemd service

Create virtualenv + install:

```bash
cd /opt/ai-calling-platform/agent-python
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
```

Create service file:

```bash
sudo tee /etc/systemd/system/ai-interview-agent.service >/dev/null <<'EOF'
[Unit]
Description=AI Interview Agent Worker
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/ai-calling-platform/agent-python
EnvironmentFile=/opt/ai-calling-platform/agent-python/.env
ExecStart=/opt/ai-calling-platform/agent-python/.venv/bin/python interview_agent_entrypoint.py dev
Restart=always
RestartSec=3
User=ubuntu

[Install]
WantedBy=multi-user.target
EOF
```

Enable/start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable ai-interview-agent
sudo systemctl start ai-interview-agent
sudo systemctl status ai-interview-agent
```

Logs:

```bash
journalctl -u ai-interview-agent -f
```

---

## 8) Nginx reverse proxy config

```bash
sudo tee /etc/nginx/sites-available/ai-calling-platform >/dev/null <<'EOF'
server {
    listen 80;
    server_name <your-domain>;

    root /opt/ai-calling-platform/dashboard-react/dist;
    index index.html;

    location /api/ {
        proxy_pass http://127.0.0.1:4040/api/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        try_files $uri /index.html;
    }
}
EOF
sudo ln -sf /etc/nginx/sites-available/ai-calling-platform /etc/nginx/sites-enabled/ai-calling-platform
sudo nginx -t && sudo systemctl reload nginx
```

Enable TLS:

```bash
sudo certbot --nginx -d <your-domain>
```

---

## 9) Production checks (end-to-end)

1. Open `https://<your-domain>`
2. Start session:
   - `POST /api/interviews/session/start`
   - confirm `candidateJoinUrl` returns your domain
3. Open join URL:
   - candidate joins room
   - avatar/agent appears
4. Verify DB writes:
   - `interview_sessions`
   - `interview_events`
   - `interview_evaluations`

Quick API checks:

```bash
curl https://<your-domain>/api/health
curl https://<your-domain>/api/interviews/sessions?limit=5
```

---

## 10) Updating deployment

```bash
cd /opt/ai-calling-platform
git pull

cd backend-node && npm ci
pm2 restart ai-calling-backend

cd ../dashboard-react && npm ci && npm run build
sudo systemctl reload nginx

cd ../agent-python
source .venv/bin/activate
pip install -r requirements.txt
sudo systemctl restart ai-interview-agent
```

---

## 11) Common issues

- **Join URL points to localhost**  
  Set `APP_BASE_URL=https://<your-domain>` in backend env.

- **Agent not joining room**  
  Verify `INTERVIEW_AGENT_NAME` matches in backend + agent env; check `journalctl -u ai-interview-agent -f`.

- **High `/api/interviews/session/:id` traffic**  
  Frontend polling interval controls this; current join page polling is throttled and visibility-aware.

- **3 participants (agent + avatar + candidate)**  
  Avatar mode intentionally introduces worker participant; frontend should map avatar/agent correctly.

---

## Related docs

- LiveKit transport on EC2: `docs/LiveKitEC2.md`
- Interview architecture: `docs/LIVEKIT_VIDEO_INTERVIEW_E2E.md`
- General architecture: `docs/ARCHITECTURE.md`

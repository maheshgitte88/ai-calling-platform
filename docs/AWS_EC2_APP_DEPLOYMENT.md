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

### Alternative: Python agents with PM2 (same EC2)

Use this if you prefer PM2 over systemd (same virtualenv and `.env`). **Do not** run the same agent under both systemd and PM2.

```bash
cd /home/ubuntu/services/ai-calling-platform/agent-python
# If systemd was used:
sudo systemctl disable --now ai-interview-agent 2>/dev/null || true

pm2 start ecosystem.config.cjs --only ai-interview-agent
# Optional second worker (outbound voice calls) — only if you need it on this host:
# pm2 start ecosystem.config.cjs --only ai-calling-agent

pm2 save
sudo env PATH=$PATH:/usr/bin $(which pm2) startup systemd -u ubuntu --hp /home/ubuntu
# Run the command PM2 prints if different.
```

Useful commands:

```bash
pm2 status
pm2 logs ai-interview-agent --lines 100
pm2 restart ai-interview-agent --update-env
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


Here’s a straightforward way to **change `agent-python/.env`** and **restart** the worker.

### 1. Edit the file on the server (SSH)

```bash
cd ~/services/ai-calling-platform/agent-python
nano .env
```

Change what you need (e.g. `LIVEKIT_URL=wss://livekit.maheshgitte.online`), save (**Ctrl+O**, Enter) and exit (**Ctrl+X**).

---

### 2. Restart the interview agent

Use **whichever** you actually use on that machine.

**If it runs under systemd** (e.g. `ai-interview-agent`):

```bash
sudo systemctl restart ai-interview-agent
sudo systemctl status ai-interview-agent --no-pager
```

Logs:

```bash
journalctl -u ai-interview-agent -n 50 --no-pager
```

**If it runs under PM2** (`ecosystem.config.cjs`):

```bash
cd ~/services/ai-calling-platform/agent-python
pm2 restart ai-interview-agent --update-env
pm2 logs ai-interview-agent --lines 40
```

(`--update-env` matters if you also changed env vars that PM2 injected; Python still reads `.env` on process start, so a normal `pm2 restart ai-interview-agent` is usually enough after editing `.env`.)

---

### 3. Confirm it picked up LiveKit

In the logs you should see something like **`registered worker`** with **`"url": "wss://livekit.maheshgitte.online"`** (or your `LIVEKIT_URL`).

---

**Note:** Don’t run **both** systemd **and** PM2 for the same agent—only one process should own `interview_agent_entrypoint.py`.


<!-- how to setup nginx -->

Here’s a concise **Nginx on Ubuntu EC2** setup for **`livekit.maheshgitte.online`** (WSS → LiveKit **7880**) and **`api.maheshgitte.online`** (HTTPS → Node **4040** `/api/`).

---

### 1. Install Nginx

```bash
sudo apt update
sudo apt install -y nginx
sudo systemctl enable nginx
sudo systemctl start nginx
```

---

### 2. Create the site config

```bash
sudo tee /etc/nginx/sites-available/ai-calling-tls >/dev/null <<'EOF'
# LiveKit signaling → WSS after Certbot
server {
    listen 80;
    listen [::]:80;
    server_name livekit.maheshgitte.online;

    location / {
        proxy_pass http://127.0.0.1:7880;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
        proxy_send_timeout 86400;
    }
}

# Node API
server {
    listen 80;
    listen [::]:80;
    server_name api.maheshgitte.online;

    location /api/ {
        proxy_pass http://127.0.0.1:4040/api/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        return 404;
    }
}
EOF
```

Enable it and drop the default site if you don’t need it:

```bash
sudo rm -f /etc/nginx/sites-enabled/default
sudo ln -sf /etc/nginx/sites-available/ai-calling-tls /etc/nginx/sites-enabled/ai-calling-tls
sudo nginx -t && sudo systemctl reload nginx
```

---

### 3. Open ports (AWS + optional UFW)

- **EC2 security group:** **80** and **443** inbound from the internet.  
- **UFW (if used):**  
  `sudo ufw allow 'Nginx Full'`  
  or `sudo ufw allow 80,443/tcp`

---

### 4. TLS with Certbot (HTTP → HTTPS on both names)

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d livekit.maheshgitte.online -d api.maheshgitte.online
```

Certbot will add **443** + redirect and keep the **proxy** settings.

Test:

```bash
curl -sS https://livekit.maheshgitte.online/
curl -sS -o /dev/null -w "%{http_code}\n" https://api.maheshgitte.online/api/health
```

(Use a real health path if you have one; otherwise try any known `/api/...` route.)

---

### 5. App environment (after HTTPS works)

**Backend + agent `.env`:**

```env
LIVEKIT_URL=wss://livekit.maheshgitte.online
```

**Amplify (or any HTTPS frontend):**

```text
VITE_API_BASE_URL=https://api.maheshgitte.online
```

**`APP_BASE_URL`** = your public app URL (e.g. Amplify). Restart **PM2** backend and the **Python agent** after changing **LiveKit** env.

---

### 6. Reminders

- LiveKit **UDP** (e.g. **50000–60000**) must still be open in the security group.  
- Node must be listening on **`127.0.0.1:4040`**, LiveKit on **`127.0.0.1:7880`**.  
- If **403/404** on static files, that’s expected on **`api.…`** if you only proxy **`/api/`**.

That’s the full Nginx path: **install → config → `nginx -t` → Certbot → update envs**.
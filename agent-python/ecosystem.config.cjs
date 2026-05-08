/**
 * PM2 process file for LiveKit Python agents.
 *
 * Usage (from this directory, after `python3 -m venv .venv` + `pip install -r requirements.txt`):
 *   pm2 start ecosystem.config.cjs --only ai-interview-agent
 *
 * Logs: pm2 logs ai-interview-agent
 * Save: pm2 save
 *
 * Linux interpreter path below (.venv/bin/python). On Windows dev, either run under WSL
 * or change interpreter to .venv\\Scripts\\python.exe in a local override.
 */
const path = require("path");

const cwd = __dirname;
const venvPython =
  process.platform === "win32"
    ? path.join(cwd, ".venv", "Scripts", "python.exe")
    : path.join(cwd, ".venv", "bin", "python");

module.exports = {
  apps: [
    {
      name: "ai-interview-agent",
      cwd,
      script: "interview_agent_entrypoint.py",
      interpreter: venvPython,
      args: ["dev"],
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 80,
      min_uptime: "10s",
      exp_backoff_restart_delay: 500,
      watch: false,
      time: true,
    },
  ],
};

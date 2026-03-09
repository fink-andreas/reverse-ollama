# Deployment Runbook (Debian)

This runbook describes how to deploy reverse-ollama as a systemd service on Debian.

## 1) Prerequisites
- Debian host with systemd
- Ollama reachable at `127.0.0.1:11434` (or a custom upstream)
- reverse-ollama source checked out at your chosen path (examples below use `/home/<user>/reverse-ollama`)
- Node.js available

> Note: If Node.js is installed via nvm/fnm/asdf, systemd may not find `node` automatically. Use a service override with an absolute Node path.

---

## 2) Install project dependencies
From the project directory:

```bash
cd /home/<user>/reverse-ollama
npm install
```

---

## 3) Install the systemd unit

```bash
sudo cp systemd/reverse-ollama.service /etc/systemd/system/reverse-ollama.service
sudo systemctl daemon-reload
sudo systemctl enable --now reverse-ollama
```

Check status:

```bash
systemctl status reverse-ollama
```

Follow logs:

```bash
sudo journalctl -u reverse-ollama -f
```

---

## 4) If systemd cannot find `node`
Symptom in logs:
- `/usr/bin/env: 'node': No such file or directory`

Find absolute node path:

```bash
which node
readlink -f "$(which node)"
```

Create/edit override:

```bash
sudo systemctl edit reverse-ollama
```

Add:

```ini
[Service]
ExecStart=
ExecStart=/absolute/path/to/node /home/<user>/reverse-ollama/src/server.js
```

Apply:

```bash
sudo systemctl daemon-reload
sudo systemctl restart reverse-ollama
systemctl status reverse-ollama
```

---

## 5) If default port is already in use
Symptom in logs:
- `EADDRINUSE: address already in use 0.0.0.0:11435`

Either free the port or set another port in override.

Check who uses the port:

```bash
sudo lsof -i :11435
```

Set custom port (example `11436`):

```bash
sudo systemctl edit reverse-ollama
```

Add or adjust:

```ini
[Service]
Environment=PORT=11436
```

Apply:

```bash
sudo systemctl daemon-reload
sudo systemctl restart reverse-ollama
```

---

## 6) Optional: adjust upstream/config path
Edit override:

```bash
sudo systemctl edit reverse-ollama
```

Example:

```ini
[Service]
Environment=OLLAMA_UPSTREAM=http://127.0.0.1:11434
Environment=REVERSE_OLLAMA_CONFIG=/home/<user>/reverse-ollama/config/categories.json
```

Apply:

```bash
sudo systemctl daemon-reload
sudo systemctl restart reverse-ollama
```

---

## 7) Verify deployment
Use the configured service port (default `11435`, or your override value):

```bash
curl -sS http://127.0.0.1:<port>/api/tags
```

Expected:
- JSON response from Ollama model tags via reverse-ollama.

---

## 8) Useful operations
Restart service:

```bash
sudo systemctl restart reverse-ollama
```

Stop/start service:

```bash
sudo systemctl stop reverse-ollama
sudo systemctl start reverse-ollama
```

Reload config without full restart (SIGHUP supported):

```bash
sudo systemctl kill -s HUP reverse-ollama
```

View effective unit with overrides:

```bash
systemctl cat reverse-ollama
```

Disable service:

```bash
sudo systemctl disable --now reverse-ollama
```

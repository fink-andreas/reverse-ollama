# reverse-ollama

reverse-ollama is a Node.js reverse proxy for Ollama.

It listens on `11435` (default), forwards traffic to `127.0.0.1:11434`, supports streaming, can categorize requests via regex rules, and can apply request actions (for example model replacement and context-size overrides).

## Features
- Transparent reverse proxy for Ollama endpoints
- Streaming-safe forwarding for request/response bodies
- Configurable category matching via JSON config
- Configurable actions per category:
  - replace `model`
  - set `options.num_ctx`
  - deduplicate repeated instruction lines in `prompt` / `input` / `messages[].content` (`actions.deduplication: true`) when at least 60 characters are affected
  - shallow merge top-level fields via `actions.set`
- Structured JSON logs (journald-friendly)
- systemd service unit for Debian

## Requirements
- Node.js >= 20
- Ollama running locally (default upstream: `http://127.0.0.1:11434`)

## Install
```bash
npm install
```

## Run locally
```bash
npm start
```

Environment variables:
- `PORT` (default `11435`)
- `HOST` (default `0.0.0.0`)
- `OLLAMA_UPSTREAM` (default `http://127.0.0.1:11434`)
- `REVERSE_OLLAMA_CONFIG` (default `config/categories.json`)
- `UPSTREAM_TIMEOUT_MS` (default `60000`)
## Session Viewer Web Server

A web UI for viewing session logs.

- Listens on host/port configurable via `SESSION_VIEWER_HOST` (default: `127.0.0.1`) and `SESSION_VIEWER_PORT` (default: `3000`)
- Set `SESSION_VIEWER_HOST=0.0.0.0` to expose it on all interfaces
- Basic auth protection via `SESSION_VIEWER_PASSWORD` (username: `admin`) — required; server exits if unset
- Shows session list on first screen with ability to click on a specific session
- Session list includes `Tokens` (in/out) and `Time` (request→response duration)
- Shows session details with back button to session list

- Pi-compatible session format (tree structure with entries)
- `src/pi-session-format.js` - Transforms request/response to to pi format
- `src/session-viewer-server.js` - Web server for viewing sessions
- `src/session-viewer.html` - Standalone HTML viewer
- `sample-session-viewer.html` - Demo HTML with sample sessions

- `tests/session-viewer.test.js` - Integration tests for session viewer server

### Session logs
When `SESSION_LOG_ENABLED=true`, the proxy appends JSONL entries with full request/response pairs to:
- `/var/log/reverse-ollama/sessions/session-YYYY-MM-DD-HH-mm-ss-SSS-<source>.jsonl` (default, UTC timestamp)
- or `SESSION_LOG_DIR` override

`<source>` is resolved from request source in this order:
1. `x-forwarded-for` (first IP)
2. `x-forwarded`
3. socket remote address

Each line includes request metadata (including `source`), matched category/actions, incoming/outgoing request bodies, and response status/body.

## Configuration
Default config path: `config/categories.json`

Minimal config:
```json
{
  "categories": []
}
```

Example config:
```json
{
  "categories": [
    {
      "name": "coding-requests",
      "endpoints": ["/api/chat", "/api/generate"],
      "match": {
        "messagesRegex": "code|debug|programming",
        "flags": "i"
      },
      "actions": {
        "model": "codellama:latest",
        "num_ctx": 16384,
        "deduplication": true,
        "set": {
          "temperature": 0.2
        }
      }
    }
  ]
}
```

### Match fields
Inside `match`:
- `pathRegex`
- `modelRegex`
- `promptRegex`
- `messagesRegex`
- `rawRegex`
- `flags` (regex flags applied to all regex fields in the same category)

Matching behavior:
- category list is evaluated in order
- first matching category is used
- if no regex fields are defined, endpoint-only matching is used

- `src/logger.js`: structured logger setup
- `src/session-log.js`: session log utilities (directory, filename sanitization)
- `src/pi-session-format.js`: pi-compatible session format transformation
- `src/session-viewer-server.js`: session viewer web server
- `src/server.js`: HTTP server lifecycle, config load/reload, graceful shutdown
- `src/proxy.js`: upstream forwarding, streaming, request classification + mutation pipeline
- `src/config.js`: config load, schema validation, regex compilation
- `src/matcher.js`: category matching logic (ordered first-match)
- `src/transform.js`: category action application
- `src/logger.js`: structured logger setup

## Usage examples
Proxy request:
```bash
curl -s http://127.0.0.1:11435/api/tags
```

Chat request through proxy:
```bash
curl -s http://127.0.0.1:11435/api/chat \
  -H 'content-type: application/json' \
  -d '{"model":"llama3.2","messages":[{"role":"user","content":"hello"}]}'
```

## systemd setup (Debian)
Service file: `systemd/reverse-ollama.service`

Detailed runbook: `docs/DEPLOYMENT_DEBIAN.md`

Install:
```bash
sudo cp systemd/reverse-ollama.service /etc/systemd/system/reverse-ollama.service
sudo systemctl daemon-reload
sudo systemctl enable --now reverse-ollama
```

Check status/logs:
```bash
systemctl status reverse-ollama
journalctl -u reverse-ollama -f
```

Enable debug payload logs temporarily:
```bash
LOG_LEVEL=debug LOG_PAYLOADS=true npm start
```

For systemd, add an override:
```ini
[Service]
Environment=LOG_LEVEL=debug
Environment=LOG_PAYLOADS=true
Environment=LOG_PAYLOAD_MAX_BYTES=4096
```

### Local systemd override (custom Node path / custom port)
If Node is installed in a user-managed location (for example nvm/fnm/asdf), create a systemd override with an absolute Node path.

Override file location:
- `/etc/systemd/system/reverse-ollama.service.d/override.conf`

Create/edit it:
```bash
sudo systemctl edit reverse-ollama
```

Example override (neutral template):
```ini
[Service]
ExecStart=
ExecStart=/home/<user>/.nvm/versions/node/<version>/bin/node /home/<user>/reverse-ollama/src/server.js
Environment=PORT=<port>
```

Apply changes:
```bash
sudo systemctl daemon-reload
sudo systemctl restart reverse-ollama
```

Inspect effective unit + overrides:
```bash
systemctl cat reverse-ollama
```

## Tests
```bash
npm test
```

## Run session viewer
`SESSION_VIEWER_PASSWORD` is mandatory.

```bash
SESSION_VIEWER_PASSWORD=secret npm run viewer
```

With custom env:
```bash
SESSION_VIEWER_HOST=0.0.0.0 SESSION_VIEWER_PORT=8080 SESSION_VIEWER_PASSWORD=secret SESSION_LOG_DIR=/var/log/reverse-ollama/sessions npm run viewer
```

## systemd setup for session viewer (Debian)
Service file: `systemd/reverse-ollama-viewer.service`

Create `/etc/default/reverse-ollama-viewer` with a password:
```bash
sudo tee /etc/default/reverse-ollama-viewer >/dev/null <<'EOF'
SESSION_VIEWER_PASSWORD=change-me-strong-password
EOF
sudo chmod 600 /etc/default/reverse-ollama-viewer
```

Install and start:
```bash
sudo cp systemd/reverse-ollama-viewer.service /etc/systemd/system/reverse-ollama-viewer.service
sudo systemctl daemon-reload
sudo systemctl enable --now reverse-ollama-viewer
```

## Troubleshooting
- `EADDRINUSE` on startup:
  - another process already uses `PORT` (default `11435`)
  - run with another port: `PORT=18080 npm start`
- Config validation errors on startup:
  - check JSON syntax and regex patterns in config file
- Upstream failures:
  - verify Ollama is reachable at `OLLAMA_UPSTREAM`
  - check logs with `journalctl -u reverse-ollama -f`

## Notes
- If a request body is JSON and category matching is configured, the proxy may buffer request input to inspect/mutate it.
- Response streaming remains pass-through.

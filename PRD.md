We create a reverse proxy for Ollama.

The reverse proxy:
- listens on port 11435
- connects to Ollama on 127.0.0.1:11434
- is implemented in Node.js
- runs as a systemd service
- forwards everything transparently
- supports streaming
- supports detection of specific request categories via regexp
- has configurable categories (e.g. via JSON config file)
- can apply actions to categories, like replacing model name and adding/replacing/changing context size (or other completions API related fields)
- supports optional instruction deduplication action (`actions.deduplication: true`) that removes repeated lines in `prompt`, `input`, and `messages[].content` only if deduplication impact crosses a minimum threshold (default: 60 affected characters)
- provides structured logs
- keeps payload content out of normal logs by default
- supports debug-only request/response payload logging controlled by environment flags
- supports configurable upstream timeout via environment variable (`UPSTREAM_TIMEOUT_MS`) with default `60000`
- supports optional session logging that stores full request/response pairs as JSONL files on disk (Debian default: `/var/log/reverse-ollama/sessions`) using source-aware filenames with UTC timestamp granularity down to milliseconds (prefer `x-forwarded-for`, then `x-forwarded`, then socket IP)
- session JSONL entries use a pi-compatible session structure (header + entries tree + leafId) while preserving raw proxy request/response metadata under `_proxy`
- includes a built-in session viewer web server for browsing stored sessions
  - viewer host is configurable via `SESSION_VIEWER_HOST` (default: `127.0.0.1`, set `0.0.0.0` for external access)
  - viewer port is configurable via `SESSION_VIEWER_PORT` (default: `3000`)
  - mandatory basic auth with username `admin` and password from `SESSION_VIEWER_PASSWORD` (viewer must not start without password)
  - first screen lists sessions; selecting a session shows details and a back button
  - session list columns include `Tokens` (in/out per request) and `Time` (request-to-response duration)
  - session detail header also shows `Tokens` (in/out) and request `Time`
  - session detail message bodies preserve line breaks and are rendered as plain escaped text (no Markdown-to-HTML conversion)
  - browser back/forward navigation must mirror in-app navigation between list and detail views

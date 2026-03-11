# reverse-ollama Project Status

## Current Progress

### Overall status
- Planning completed
- Implementation completed for all main milestones
- Test suite passing

### Completed
- Read and reviewed `PRD.md`
- Produced implementation plan and milestone breakdown
- Recorded project planning and tracking documents
- Added maintenance rules for plans, milestones, and todos to `AGENTS.md`
- Implemented Node.js project scaffold and dependency setup
- Implemented transparent reverse proxy to Ollama upstream
- Implemented streaming-safe proxying for request/response forwarding
- Implemented JSON config system with schema validation and regex compilation
- Implemented category matching engine (ordered first-match)
- Implemented transformation engine:
  - model replacement
  - `options.num_ctx` set/override
  - optional shallow merge via `actions.set`
  - optional request-text deduplication via `actions.deduplication` for `prompt`, `input`, and `messages[].content`
- Implemented structured logging with request metadata and category/action fields
- Implemented error handling for invalid JSON, upstream failures, and timeouts
- Implemented graceful shutdown and config reload (`SIGHUP`)
- Added systemd unit file for Debian deployment
- Added unit and integration tests (including streaming and failure behavior)
- Added `README.md` with architecture, config format, run steps, systemd deployment, and troubleshooting
- Documented neutral systemd override usage for absolute Node path and custom port (`override.conf`)
- Added Debian deployment runbook: `docs/DEPLOYMENT_DEBIAN.md`
- Added debug-only payload logging controls:
  - `LOG_PAYLOADS=true` (explicit opt-in)
  - requires `LOG_LEVEL=debug`/`trace`
  - `LOG_PAYLOAD_MAX_BYTES` truncation guard
- Added integration test coverage for payload debug logging behavior
- Fixed proxy compatibility with clients sending `Expect` header by filtering unsupported `Expect` before undici upstream dispatch
- Added integration test coverage for `Expect: 100-continue` forwarding behavior
- Increased default upstream timeout to `60000ms` (configurable via `UPSTREAM_TIMEOUT_MS`)
- Added debug response payload logging (truncated by `LOG_PAYLOAD_MAX_BYTES`) alongside existing request payload debug logging
- Added optional session JSONL logging for full request/response pairs (`SESSION_LOG_ENABLED`, `SESSION_LOG_DIR`)
- Updated session JSONL file naming to include request source (prefer `x-forwarded-for`, then `x-forwarded`, then socket IP)
- Updated session JSONL filename format to include full UTC timestamp down to milliseconds (`session-YYYY-MM-DD-HH-mm-ss-SSS-<source>.jsonl`)
- Added pi-compatible session conversion (`src/pi-session-format.js`) and integrated it into proxy session logging
- Added session viewer web server (`src/session-viewer-server.js`) with JSON APIs and embedded HTML UI (list/detail + back navigation)
- Added session viewer authentication via basic auth (`admin` + `SESSION_VIEWER_PASSWORD`)
- Added session viewer integration tests and fixed startup/runtime issues (duplicate imports, temp dir setup)
- Added CLI/npm entrypoint for viewer (`npm run viewer`)
- Added configurable session viewer bind host via `SESSION_VIEWER_HOST` (default `127.0.0.1`, supports `0.0.0.0`)
- Enforced mandatory viewer auth: `SESSION_VIEWER_PASSWORD` is required and viewer exits if missing
- Added dedicated systemd unit for viewer: `systemd/reverse-ollama-viewer.service`
- Updated viewer navigation so browser back/forward mirrors in-app list/detail navigation
- Extended `dvl_deploy.sh` to deploy/restart both proxy and viewer systemd units (viewer restart gated on password env file)
- Extended viewer session list with `Tokens` (in/out) and `Time` (request-to-response duration) columns
- Added token and request-time fields to session detail header in viewer
- Added proxy session metadata field `_proxy.durationMs` to support viewer request-time display
- Fixed viewer message rendering to preserve line breaks for user/assistant/system content (`.message-content { white-space: pre-wrap }`)
- Rendered viewer message content as plain escaped text with preserved line breaks (no Markdown-to-HTML conversion)
- Fixed HTML-template escaping issues in embedded viewer message rendering logic
- Reduced session viewer paragraph/typography spacing for denser readability
- Reworked viewer typography CSS to use dedicated content line-height decoupled from layout spacing
- Refined viewer message typography with container font-size reset and explicit message-content text sizing/paragraph line-height
- Unified message text block rendering structure for user/assistant/system to ensure consistent line rendering behavior
- Updated viewer plain-text renderer to emit paragraph tags from blank-line-separated content (with `<br>` for intra-paragraph line breaks)
- Refined deduplication strategy to a scalable threshold-based approach: deduplication is applied only when duplicate removal impact reaches at least 60 affected characters (reverted special-case handling)

---

## Milestone Status

| Milestone | Name | Status |
|---|---|---|
| 1 | Bootstrap the service | Done |
| 2 | Transparent reverse proxy | Done |
| 3 | Streaming support | Done |
| 4 | Config system | Done |
| 5 | Category matching engine | Done |
| 6 | Transformation engine | Done |
| 7 | Structured logging | Done |
| 8 | Error handling and resilience | Done |
| 9 | systemd integration | Done |
| 10 | Tests | Done |
| 11 | Documentation | Done |

---

## Current Focus
- All main milestones are complete.
- Session logging now emits pi-compatible sessions and includes a web session viewer with optional auth.
- Current focus is documentation polish and operational hardening for the new viewer flow.

---

## Next Steps (optional)
1. Add CI workflow for tests and linting
2. Add request/response metrics export (Prometheus)
3. Add benchmark script for streaming latency/throughput
4. Add viewer pagination/filtering for large session directories
5. Add hot config reload by file watcher (optional)

---

## Notes
- Local port `11435` may be occupied on this host; override with `PORT` for local runs.
- Keep this file updated when optional hardening work starts.

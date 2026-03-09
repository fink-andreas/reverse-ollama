# reverse-ollama Implementation Plan

## Objective
Build a Node.js reverse proxy for Ollama that listens on port `11435`, forwards traffic to `127.0.0.1:11434`, supports transparent proxying and streaming, detects request categories via regexp, applies configurable request transformations, emits structured logs, and runs as a systemd service on Debian.

## Scope Summary
The implementation must provide:
- Transparent reverse proxying for Ollama traffic
- Streaming-safe request/response handling
- Configurable category detection using regexp-based matching
- Configurable actions such as model replacement and context-size changes
- Structured logging
- systemd deployment support

---

## Milestones

### Milestone 1: Bootstrap the service
**Goal:** Create a runnable Node.js service skeleton.

**Tasks:**
- Create project structure:
  - `src/server.js`
  - `src/proxy.js`
  - `src/config.js`
  - `src/matcher.js`
  - `src/transform.js`
  - `src/logger.js`
  - `config/categories.json`
  - `systemd/reverse-ollama.service`
- Initialize `package.json`
- Add dependencies for:
  - HTTP/proxy support
  - structured logging
  - config validation
- Add npm scripts:
  - `start`
  - `dev`
  - `test`

**Deliverable:**
- Service starts and listens on port `11435`

---

### Milestone 2: Transparent reverse proxy
**Goal:** Forward all traffic to Ollama unchanged.

**Tasks:**
- Listen on `0.0.0.0:11435`
- Forward requests to `127.0.0.1:11434`
- Preserve:
  - method
  - path
  - query string
  - relevant headers
  - status code
  - response headers
- Add request ID generation
- Log incoming request and upstream response metadata

**Deliverable:**
- Requests to the proxy behave like direct requests to Ollama

**Acceptance checks:**
- `GET` and `POST` work
- non-JSON endpoints still pass through
- headers and status codes are preserved

---

### Milestone 3: Streaming support
**Goal:** Support Ollama streaming correctly.

**Tasks:**
- Implement request/response piping without unnecessary buffering
- Ensure chunked responses stream to client immediately
- Handle:
  - client disconnect
  - upstream disconnect
  - long-lived streams
- Verify proxy does not accumulate full response in memory

**Deliverable:**
- `/api/generate` and `/api/chat` streaming work transparently

**Acceptance checks:**
- streamed tokens arrive incrementally
- no broken JSON chunk boundaries caused by proxy
- cancellation/disconnect does not crash service

---

### Milestone 4: Config system
**Goal:** Support configurable request categorization and actions.

**Tasks:**
- Define JSON config schema
- Create startup config loader
- Validate config on boot
- Add clear validation errors
- Decide config path strategy:
  - default path
  - optional env override

**Suggested config model:**
- `categories[]`
  - `name`
  - `endpoints`
  - `match`
  - `actions`

**Deliverable:**
- Service starts with validated config and exits clearly on invalid config

**Acceptance checks:**
- invalid regex is detected
- missing required fields fail fast
- empty config still allows transparent proxying

---

### Milestone 5: Category matching engine
**Goal:** Detect requests that belong to configured categories.

**Tasks:**
- Parse JSON request bodies only when needed
- Support matching on:
  - endpoint/path
  - `model`
  - `prompt`
  - `messages[].content`
  - optional raw request body fallback
- Support regex-based matching
- Define matching order semantics:
  - first match wins
  - or multiple categories allowed
- Return matched category metadata for logging and transforms

**Deliverable:**
- Requests can be classified into named categories

**Acceptance checks:**
- regex matches prompt text
- regex matches chat message content
- unmatched requests continue as pass-through

---

### Milestone 6: Transformation engine
**Goal:** Apply actions to matched request categories.

**Tasks:**
- Implement action handlers for MVP:
  - replace `model`
  - set/override `num_ctx`
- Make action pipeline extensible for later additions
- Apply transforms only to JSON requests where valid
- Recompute request body and headers after mutation
- Preserve untouched requests as streamed pass-through where possible

**Deliverable:**
- Matched requests can be modified before reaching Ollama

**Acceptance checks:**
- model replacement works
- `num_ctx` added if missing
- `num_ctx` overridden if present
- no mutation occurs for unmatched requests

---

### Milestone 7: Structured logging
**Goal:** Add useful operational logs.

**Tasks:**
- Emit structured JSON logs
- Log fields such as:
  - timestamp
  - level
  - request ID
  - client IP
  - method
  - path
  - matched category
  - applied actions
  - upstream status
  - duration
  - error
- Avoid logging full prompts by default
- Add debug mode for optional payload logging with explicit opt-in flags

**Deliverable:**
- Logs are machine-readable and suitable for journald ingestion

**Acceptance checks:**
- each request has one start/end traceable via request ID
- errors include context
- matched categories/actions are visible
- payload logging stays disabled by default and is available only in debug mode with explicit opt-in

---

### Milestone 8: Error handling and resilience
**Goal:** Fail safely and predictably.

**Tasks:**
- Handle upstream unavailable/refused connection
- Handle invalid client JSON
- Handle invalid transform action data
- Return clear HTTP error responses
- Make sure unexpected exceptions do not crash the process silently
- Add graceful shutdown handling for systemd

**Deliverable:**
- Service behaves predictably during failures

**Acceptance checks:**
- upstream down returns sensible error
- malformed JSON returns client error
- shutdown drains active requests cleanly if possible

---

### Milestone 9: systemd integration
**Goal:** Run reliably as a Debian service.

**Tasks:**
- Create `systemd/reverse-ollama.service`
- Configure:
  - `ExecStart`
  - `WorkingDirectory`
  - restart policy
  - environment/config path
  - log output to journald
- Document installation steps
- Optionally create dedicated user/group

**Deliverable:**
- Service can be enabled and started with systemd

**Acceptance checks:**
- `systemctl start reverse-ollama`
- `systemctl status reverse-ollama`
- auto-restart on failure works

---

### Milestone 10: Tests
**Goal:** Validate core behavior before production use.

**Tasks:**
- Unit tests for:
  - config validation
  - category matching
  - transformations
- Integration tests for:
  - transparent forwarding
  - streaming forwarding
  - matched request mutation
  - backend failure handling
- Add a mock upstream server for test runs

**Deliverable:**
- Repeatable automated verification of proxy behavior

**Acceptance checks:**
- green test suite for MVP features

---

### Milestone 11: Documentation
**Goal:** Make deployment and maintenance easy.

**Tasks:**
- Write `README.md`
- Document:
  - purpose
  - architecture
  - config file format
  - example categories
  - running locally
  - systemd deployment
  - troubleshooting
- Include curl examples

**Deliverable:**
- A new user can install, configure, and run the proxy from docs alone

---

## MVP Backlog
Implement in this order:
1. Node.js scaffold
2. Transparent proxy
3. Streaming support
4. Config loading
5. Category matcher
6. Actions: `replace model`, `set num_ctx`
7. Structured logging
8. systemd service
9. Tests
10. Documentation

---

## Suggested Config Example
```json
{
  "categories": [
    {
      "name": "coding-requests",
      "endpoints": ["/api/generate", "/api/chat"],
      "match": {
        "messagesRegex": "code|programming|debug"
      },
      "actions": {
        "model": "codellama:latest",
        "num_ctx": 16384
      }
    }
  ]
}
```

---

## MVP Acceptance Criteria
The MVP is done when:
- proxy listens on `11435`
- forwards to `127.0.0.1:11434`
- supports streaming correctly
- loads category config from JSON
- matches requests by regex
- can replace model name
- can add/override context size
- emits structured logs
- runs as systemd service on Debian

---

## Risks
- Streaming can break if responses are buffered accidentally
- Request mutation requires buffering/parsing JSON requests before forwarding
- Ollama request schemas differ by endpoint, so transforms should be endpoint-aware
- Regex matching across chat message arrays needs careful normalization

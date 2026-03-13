We develop on this host directly, Debian.

Always read PRD.md before starting working on this project.

Always update PRD.md when the requiremets are changed by interaction with the user and from context.

## Planning and tracking rules

Maintain the following planning documents:
- `docs/IMPLEMENTATION_PLAN.md` for the full implementation plan and milestones
- `docs/PROJECT_STATUS.md` for current progress, milestone state, and next steps
- `docs/TODO.md` for actionable task checklists

When working on the project:
- Read `docs/IMPLEMENTATION_PLAN.md`, `docs/PROJECT_STATUS.md`, and `docs/TODO.md` before starting implementation work after planning exists
- Update `docs/PROJECT_STATUS.md` whenever progress changes
- Update `docs/TODO.md` whenever tasks are started, completed, added, split, or reordered
- Keep milestone names and ordering consistent across all planning documents
- Record the next concrete implementation steps in `docs/PROJECT_STATUS.md`
- Mark partial progress clearly as `In progress` rather than `Done`
- Do not remove completed items from `docs/TODO.md`; mark them completed instead
- If requirements change, update `PRD.md` first, then update the planning documents to reflect the new requirements

## Debugging Sessions

Session logs are stored in `/var/log/reverse-ollama/sessions/` as JSONL files. Each file contains one or more session records with HTTP request/response data.

**Important:** The session log directory is owned by root (the proxy typically runs as a systemd service). Use `sudo` for all file access commands.

### Session file naming convention

```
session-YYYY-MM-DD-HH-MM-SS-msec-source.jsonl
```

Example: `session-2026-03-13-01-43-06-141-46.232.228.55.jsonl`

### Inspecting session files

```bash
# List all sessions (requires sudo)
sudo ls -la /var/log/reverse-ollama/sessions/

# Find a specific session by partial name
sudo ls /var/log/reverse-ollama/sessions/ | grep "2026-03-13-01-43"

# View session structure (keys in each JSON record)
sudo cat /var/log/reverse-ollama/sessions/session-XXX.jsonl | jq -c 'keys'

# Pretty-print a session
sudo cat /var/log/reverse-ollama/sessions/session-XXX.jsonl | jq '.'

# Extract header info (session ID, timestamps)
sudo cat /var/log/reverse-ollama/sessions/session-XXX.jsonl | jq '.header'

# Extract proxy metadata (method, path, status code, error)
sudo cat /var/log/reverse-ollama/sessions/session-XXX.jsonl | jq '._proxy'

# View request/response bodies
sudo cat /var/log/reverse-ollama/sessions/session-XXX.jsonl | jq '._proxy.incomingBody'
sudo cat /var/log/reverse-ollama/sessions/session-XXX.jsonl | jq '._proxy.responseBody'

# Count entries in a session
sudo cat /var/log/reverse-ollama/sessions/session-XXX.jsonl | jq '.entries | length'

# Quick summary of all sessions in a file
sudo cat /var/log/reverse-ollama/sessions/session-XXX.jsonl | jq -c '{id: .header.id, method: ._proxy.method, path: ._proxy.path, status: ._proxy.statusCode}'
```

### Session viewer UI

For interactive browsing, start the session viewer server:

```bash
SESSION_VIEWER_PASSWORD=secret node src/session-viewer-server.js
```

Then open http://localhost:8080 in a browser.

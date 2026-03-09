# reverse-ollama TODO

## Immediate TODOs
- [x] Initialize Node.js project
- [x] Create source tree in `src/`
- [x] Add proxy server entrypoint
- [x] Implement transparent forwarding to Ollama
- [x] Verify streaming behavior

## Milestone TODOs

### Milestone 1: Bootstrap the service
- [x] Create `package.json`
- [x] Create `src/server.js`
- [x] Create `src/proxy.js`
- [x] Create `src/config.js`
- [x] Create `src/matcher.js`
- [x] Create `src/transform.js`
- [x] Create `src/logger.js`
- [x] Create `config/categories.json`
- [x] Create `systemd/reverse-ollama.service`
- [x] Add npm scripts: `start`, `dev`, `test`

### Milestone 2: Transparent reverse proxy
- [x] Listen on `0.0.0.0:11435`
- [x] Forward requests to `127.0.0.1:11434`
- [x] Preserve method/path/query
- [x] Preserve relevant headers
- [x] Preserve status codes and response headers
- [x] Add request IDs
- [x] Log request/response metadata

### Milestone 3: Streaming support
- [x] Pipe request bodies without unnecessary buffering
- [x] Pipe response bodies without unnecessary buffering
- [x] Handle client disconnects
- [x] Handle upstream disconnects
- [x] Verify long-lived streaming stability

### Milestone 4: Config system
- [x] Define JSON config schema
- [x] Load config at startup
- [x] Validate config
- [x] Add clear startup errors for invalid config
- [x] Support default config path
- [x] Support environment override for config path

### Milestone 5: Category matching engine
- [x] Match by endpoint/path
- [x] Match by `model`
- [x] Match by `prompt`
- [x] Match by `messages[].content`
- [x] Optionally match by raw body
- [x] Define ordered matching semantics
- [x] Return match metadata

### Milestone 6: Transformation engine
- [x] Replace `model`
- [x] Add `num_ctx` when missing
- [x] Override `num_ctx` when present
- [x] Recompute request body after mutation
- [x] Recompute request headers after mutation
- [x] Keep unmatched requests as pass-through

### Milestone 7: Structured logging
- [x] Emit JSON logs
- [x] Include request ID in every request log
- [x] Include matched category in logs
- [x] Include applied actions in logs
- [x] Include duration and upstream status
- [x] Avoid logging full prompts by default

### Milestone 8: Error handling and resilience
- [x] Handle upstream unavailable errors
- [x] Handle invalid client JSON
- [x] Handle invalid transform data
- [x] Return clear HTTP errors
- [x] Add graceful shutdown

### Milestone 9: systemd integration
- [x] Create systemd unit
- [x] Configure restart policy
- [x] Configure working directory
- [x] Configure config path/environment
- [x] Document install and enable steps

### Milestone 10: Tests
- [x] Add unit tests for config validation
- [x] Add unit tests for matcher
- [x] Add unit tests for transforms
- [x] Add integration tests for transparent proxying
- [x] Add integration tests for streaming
- [x] Add integration tests for mutations
- [x] Add integration tests for backend failures

### Milestone 11: Documentation
- [x] Write `README.md`
- [x] Document architecture
- [x] Document config format
- [x] Add example categories
- [x] Document local run steps
- [x] Document systemd deployment
- [x] Add troubleshooting section

## Optional Follow-up
- [x] Add docs/DEPLOYMENT_DEBIAN.md clean runbook
- [ ] Add CI workflow for tests
- [ ] Add benchmark scripts
- [ ] Add advanced transformation plugins

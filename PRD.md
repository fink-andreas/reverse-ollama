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
- provides structured logs
- keeps payload content out of normal logs by default
- supports debug-only payload logging controlled by environment flags

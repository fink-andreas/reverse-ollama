We create a reverse proxy for ollama.

The reverse proxy:
 - listens on port 11435
 - conects to ollama on 127.0.0.1:11434
 - implemented as Nodejs
 - runs as systemd service
 - forwards everything transparentely
 - supports streaming
 - supports detection of specific request categories via regexp
 - configurable categories, e.g. via JSON config file
 - actions can be applyed to the categories, like replace model name, add/replace/change context size (or any other completions API related things)
 - logging with structured logs

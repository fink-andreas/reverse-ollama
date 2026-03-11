#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PROXY_UNIT_SRC="$ROOT_DIR/systemd/reverse-ollama.service"
VIEWER_UNIT_SRC="$ROOT_DIR/systemd/reverse-ollama-viewer.service"
PROXY_UNIT_DST="/etc/systemd/system/reverse-ollama.service"
VIEWER_UNIT_DST="/etc/systemd/system/reverse-ollama-viewer.service"
VIEWER_ENV_FILE="/etc/default/reverse-ollama-viewer"

echo "Installing systemd units..."
sudo cp "$PROXY_UNIT_SRC" "$PROXY_UNIT_DST"
sudo cp "$VIEWER_UNIT_SRC" "$VIEWER_UNIT_DST"

sudo systemctl daemon-reload

echo "Restarting reverse-ollama proxy service..."
sudo systemctl enable reverse-ollama
sudo systemctl restart reverse-ollama

if sudo test -f "$VIEWER_ENV_FILE" && sudo grep -Eq '^\s*SESSION_VIEWER_PASSWORD=.+$' "$VIEWER_ENV_FILE"; then
  echo "Restarting reverse-ollama viewer service..."
  sudo systemctl enable reverse-ollama-viewer
  sudo systemctl restart reverse-ollama-viewer
else
  echo "Skipping reverse-ollama-viewer: missing $VIEWER_ENV_FILE with SESSION_VIEWER_PASSWORD set."
  echo "Create it with:"
  echo "  sudo tee $VIEWER_ENV_FILE >/dev/null <<'EOF'"
  echo "  SESSION_VIEWER_PASSWORD=change-me-strong-password"
  echo "  EOF"
  echo "  sudo chmod 600 $VIEWER_ENV_FILE"
fi

echo "Deployment complete."

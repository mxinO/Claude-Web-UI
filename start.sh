#!/bin/bash
# Claude Code Web UI — one-command start
# Usage: ./start.sh [working-directory]
#   or:  curl -fsSL <raw-url>/start.sh | bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
CWD="${1:-$(pwd)}"
PORT="${PORT:-3001}"

# If run via curl pipe, clone first
if [ ! -f "$SCRIPT_DIR/package.json" ]; then
  echo "Cloning Claude Web UI..."
  git clone --depth 1 https://github.com/mxinO/Claude-Web-UI.git /tmp/claude-web-ui
  cd /tmp/claude-web-ui
  SCRIPT_DIR=/tmp/claude-web-ui
fi

cd "$SCRIPT_DIR"

# Install deps if needed
if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  npm install --silent
fi

# Build if needed
if [ ! -d dist/client ]; then
  echo "Building frontend..."
  npx vite build --silent
fi

# Check prerequisites
command -v tmux >/dev/null 2>&1 || { echo "Error: tmux is required. Install it with: apt install tmux"; exit 1; }
command -v claude >/dev/null 2>&1 || { echo "Error: Claude Code CLI is required. Install from: https://claude.ai/code"; exit 1; }

IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "localhost")
echo ""
echo "Starting Claude Code Web UI..."
echo "  Working directory: $CWD"
echo "  URL: http://${IP}:${PORT}"
echo ""

exec npx tsx server/index.ts "$CWD"

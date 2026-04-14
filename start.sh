#!/bin/bash
# Claude Code Web UI — one-command start
# Usage: ./start.sh [working-directory]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
CWD="${1:-$(pwd)}"
PORT="${PORT:-3001}"
TMUX_SESSION="${CLAUDE_TMUX_SESSION:-claude}"
PID_FILE="$SCRIPT_DIR/data/.server.pid"

# If run via curl pipe, clone first
if [ ! -f "$SCRIPT_DIR/package.json" ]; then
  echo "Cloning Claude Web UI..."
  git clone --depth 1 https://github.com/mxinO/Claude-Web-UI.git /tmp/claude-web-ui
  cd /tmp/claude-web-ui
  SCRIPT_DIR=/tmp/claude-web-ui
fi

cd "$SCRIPT_DIR"
mkdir -p data

# Clean up any previous instance (handles kill -9 case)
cleanup_previous() {
  # Kill old server if PID file exists
  if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE" 2>/dev/null)
    if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
      echo "Stopping previous server (PID $OLD_PID)..."
      kill "$OLD_PID" 2>/dev/null || true
      sleep 1
    fi
    rm -f "$PID_FILE"
  fi
  # Kill orphaned Claude tmux session
  tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
}

cleanup_previous

# Install deps if needed or if package.json changed since last install
if [ ! -d node_modules ] || [ ! -f node_modules/.package-lock.json ] || [ package.json -nt node_modules/.package-lock.json ]; then
  echo "Installing dependencies..."
  npm install --silent
fi

# Build if needed or if source changed since last build
if [ ! -d dist/client ] || [ -n "$(find src server \( -name '*.ts' -o -name '*.tsx' -o -name '*.css' \) -newer dist/client/index.html 2>/dev/null | head -1)" ]; then
  echo "Building frontend..."
  npx vite build --silent
fi

# Check prerequisites
command -v tmux >/dev/null 2>&1 || { echo "Error: tmux is required. Install it with: apt install tmux"; exit 1; }
command -v claude >/dev/null 2>&1 || { echo "Error: Claude Code CLI is required. Install from: https://claude.ai/code"; exit 1; }
command -v jq >/dev/null 2>&1 || echo "Warning: jq is recommended for permission handling. Install with: apt install jq"

# Cleanup on exit (Ctrl+C, SIGTERM, or normal exit)
cleanup() {
  echo ""
  echo "Shutting down..."
  tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
  rm -f "$PID_FILE"
  # Restore terminal settings (tmux/Claude can leave them broken)
  stty sane 2>/dev/null || true
}
trap cleanup EXIT

IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "localhost")
echo ""
echo "Starting Claude Code Web UI..."
echo "  Working directory: $CWD"
echo "  URL: http://${IP}:${PORT}"
echo ""

# Start server and record PID
npx tsx server/index.ts "$CWD" &
SERVER_PID=$!
echo "$SERVER_PID" > "$PID_FILE"

# Wait for server to exit
wait $SERVER_PID

#!/bin/bash
# Claude Code Web UI — one-command start
# Usage: ./start.sh [--host HOST] [--port PORT] [--no-auth] [working-directory]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
HOST="${HOST:-localhost}"
PORT="${PORT:-3001}"
CWD=""
TMUX_SESSION="${CLAUDE_TMUX_SESSION:-claude}"
PID_FILE="$SCRIPT_DIR/data/.server.pid"

# Parse arguments
while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) [[ $# -ge 2 ]] || { echo "Error: --host requires a value"; exit 1; }; HOST="$2"; shift 2 ;;
    --port) [[ $# -ge 2 ]] || { echo "Error: --port requires a value"; exit 1; }; PORT="$2"; shift 2 ;;
    --mock) MOCK=1; shift ;;
    --no-auth) NO_AUTH=1; shift ;;
    -*) echo "Unknown option: $1"; echo "Usage: ./start.sh [--host HOST] [--port PORT] [--no-auth] [working-directory]"; exit 1 ;;
    *) CWD="$1"; shift ;;
  esac
done
CWD="${CWD:-$(pwd)}"

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
  npx vite build --logLevel silent
fi

# Check prerequisites
command -v tmux >/dev/null 2>&1 || { echo "Error: tmux is required. Install it with: apt install tmux"; exit 1; }
command -v claude >/dev/null 2>&1 || { echo "Error: Claude Code CLI is required. Install from: https://claude.ai/code"; exit 1; }
command -v jq >/dev/null 2>&1 || echo "Warning: jq is recommended for permission handling. Install with: apt install jq"

# Save terminal state before anything can break it
SAVED_STTY=$(stty -g 2>/dev/null || true)

# Cleanup on exit (Ctrl+C, SIGTERM, or normal exit)
cleanup() {
  echo ""
  echo "Shutting down..."
  # Kill the server process first
  if [ -n "${SERVER_PID:-}" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
  rm -f "$PID_FILE"
  # Restore terminal to saved state
  if [ -n "${SAVED_STTY:-}" ]; then
    stty "$SAVED_STTY" 2>/dev/null || true
  else
    stty sane 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

if [ "$HOST" = "0.0.0.0" ]; then
  DISPLAY_HOST=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "localhost")
else
  DISPLAY_HOST="$HOST"
fi
echo ""
echo "Starting Claude Code Web UI..."
echo "  Working directory: $CWD"
echo "  URL: http://${DISPLAY_HOST}:${PORT}"
echo ""

# Start server and record PID
EXTRA_ARGS=""
[ "${MOCK:-}" = "1" ] && EXTRA_ARGS="$EXTRA_ARGS --mock"
[ "${NO_AUTH:-}" = "1" ] && EXTRA_ARGS="$EXTRA_ARGS --no-auth"
npx tsx server/index.ts --host "$HOST" --port "$PORT" $EXTRA_ARGS "$CWD" &
SERVER_PID=$!
echo "$SERVER_PID" > "$PID_FILE"

# Wait for server to exit
wait $SERVER_PID

#!/bin/bash
# Claude Code Web UI — one-command start
# Usage: ./start.sh [--host HOST] [--port PORT] [--no-auth] [working-directory]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
HOST="${HOST:-localhost}"
PORT="${PORT:-3001}"
CWD=""
TMUX_SESSION="${CLAUDE_TMUX_SESSION:-claude}"
TMUX_SOCKET="${CLAUDE_TMUX_SOCKET:-claude-webui}"
# Reject anything outside a safe charset — these get interpolated into shell commands.
for v in TMUX_SESSION TMUX_SOCKET; do
  [[ "${!v}" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "Error: $v must match [A-Za-z0-9_-]+"; exit 1; }
done
TMUX="tmux -L $TMUX_SOCKET"
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
# Resolve CWD to an absolute path while we're still in the user's shell —
# otherwise the `cd "$SCRIPT_DIR"` below changes what a relative path means,
# and tmux ends up trying to start claude in a directory that doesn't exist.
if [ ! -d "$CWD" ]; then
  echo "Error: working directory does not exist: $CWD"; exit 1
fi
CWD="$(cd "$CWD" && pwd)"

# If run via curl pipe, clone first
if [ ! -f "$SCRIPT_DIR/package.json" ]; then
  echo "Cloning Claude Web UI..."
  git clone --depth 1 https://github.com/mxinO/Claude-Web-UI.git /tmp/claude-web-ui
  cd /tmp/claude-web-ui
  SCRIPT_DIR=/tmp/claude-web-ui
fi

cd "$SCRIPT_DIR"
mkdir -p data

# Kill the process group of a recorded session leader (started with setsid).
# Reaps tsx/node children that would otherwise survive the wrapper.
kill_server_pgid() {
  local pgid="$1" sig="${2:-TERM}"
  [ -n "$pgid" ] && kill -0 "$pgid" 2>/dev/null || return 0
  kill "-$sig" -- "-$pgid" 2>/dev/null || true
}

# Kill anything still bound to our port — safety net for stale PID files and
# detached children left by a crashed wrapper.
kill_port_holders() {
  command -v fuser >/dev/null 2>&1 || return 0
  local sig="${1:-TERM}"
  fuser -k "-$sig" -n tcp "$PORT" 2>/dev/null || true
}

# Clean up any previous instance (handles kill -9 case)
cleanup_previous() {
  # Kill old server's process group if PID file exists
  local had_prev=0
  if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE" 2>/dev/null)
    if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
      echo "Stopping previous server (PGID $OLD_PID)..."
      kill_server_pgid "$OLD_PID" TERM
      had_prev=1
    fi
    rm -f "$PID_FILE"
  fi
  # Only escalate to fuser KILL if WE had a previous instance — children of our
  # crashed wrapper may still hold the port. Without PID-file evidence the port
  # holder isn't ours, so refuse to kill it (let the bind below fail loudly).
  if [ "$had_prev" = 1 ]; then
    sleep 1
    if command -v fuser >/dev/null 2>&1 && fuser -n tcp "$PORT" >/dev/null 2>&1; then
      echo "Force-killing leftover process(es) on port $PORT..."
      kill_port_holders KILL
      sleep 1
    fi
  fi
  # Kill orphaned Claude tmux session
  $TMUX kill-session -t "$TMUX_SESSION" 2>/dev/null || true
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
  trap - EXIT INT TERM  # prevent re-entry
  echo ""
  echo "Shutting down..."
  # Kill the entire server process group (tsx + node children)
  local had_server=0
  if [ -n "${SERVER_PID:-}" ]; then
    kill_server_pgid "$SERVER_PID" TERM
    wait "$SERVER_PID" 2>/dev/null || true
    had_server=1
  fi
  # Safety net only if our PGID kill left something behind on the port —
  # don't blanket-kill processes that aren't ours.
  if [ "$had_server" = 1 ] && command -v fuser >/dev/null 2>&1 && fuser -n tcp "$PORT" >/dev/null 2>&1; then
    kill_port_holders TERM
  fi
  $TMUX kill-session -t "$TMUX_SESSION" 2>/dev/null || true
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
# Run in a new session so SERVER_PID == PGID. This lets us reap the full
# tsx/node tree with `kill -- -$PGID`, regardless of what npx does.
setsid npx tsx server/index.ts --host "$HOST" --port "$PORT" $EXTRA_ARGS "$CWD" &
SERVER_PID=$!
echo "$SERVER_PID" > "$PID_FILE"

# Wait for server to exit
wait $SERVER_PID

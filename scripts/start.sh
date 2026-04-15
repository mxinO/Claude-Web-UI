#!/bin/bash
set -euo pipefail

HOST="${CLAUDE_WEB_UI_HOST:-localhost}"
PORT="${CLAUDE_WEB_UI_PORT:-3001}"
SESSION="claude-web-ui"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Configure hooks
"$SCRIPT_DIR/setup-hooks.sh" "$PORT"

# Kill existing tmux session if any
tmux kill-session -t "$SESSION" 2>/dev/null || true

# Create new tmux session with web server in pane 0
tmux new-session -d -s "$SESSION" -x 220 -y 50 \
  "cd '$PROJECT_DIR' && npx tsx server/index.ts --host $HOST --port $PORT"

# Split window: pane 1 = claude
tmux split-window -t "$SESSION:0" -h \
  "claude"

echo "Claude Web UI started."
echo "  URL:          http://${HOST}:${PORT}"
echo "  tmux session: $SESSION"
echo ""
echo "To attach: tmux attach -t $SESSION"

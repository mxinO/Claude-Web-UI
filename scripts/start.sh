#!/bin/bash
set -euo pipefail

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
  "cd '$PROJECT_DIR' && CLAUDE_WEB_UI_PORT=$PORT npx tsx server/index.ts"

# Split window: pane 1 = claude
tmux split-window -t "$SESSION:0" -h \
  "claude"

echo "Claude Web UI started."
echo "  URL:          http://localhost:${PORT}"
echo "  tmux session: $SESSION"
echo ""
echo "To attach: tmux attach -t $SESSION"

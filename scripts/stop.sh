#!/bin/bash
set -euo pipefail

SESSION="claude-web-ui"

# Send /exit to Claude Code pane (pane 1)
if tmux has-session -t "$SESSION" 2>/dev/null; then
  tmux send-keys -t "$SESSION:0.1" "/exit" Enter 2>/dev/null || true
  sleep 2
  tmux kill-session -t "$SESSION" 2>/dev/null || true
  echo "Stopped tmux session: $SESSION"
else
  echo "No tmux session '$SESSION' found."
fi

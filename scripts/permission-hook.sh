#!/bin/bash
set -euo pipefail
SERVER="http://localhost:${CLAUDE_WEB_UI_PORT:-3001}"
INPUT=$(cat)

# AskUserQuestion is an interactive picker, not a yes/no permission. If this
# hook returns ANY decision for it, Claude treats the question as handled by
# the hook and dismisses the picker without showing it ("you dismissed the
# picker"). Emit nothing and exit so Claude renders its native picker — the
# web UI's question watcher detects it and surfaces the options.
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || echo '')
if [ "$TOOL" = "AskUserQuestion" ]; then
  exit 0
fi

RESPONSE=$(echo "$INPUT" | curl -sf -X POST "$SERVER/hooks/permission-request" \
  -H 'Content-Type: application/json' -d @- 2>/dev/null || echo '{}')

# Check if auto-approved (bypass/auto mode)
AUTO=$(echo "$RESPONSE" | jq -r '.autoApproved // empty')
if [ "$AUTO" = "true" ]; then
  echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
  exit 0
fi

ID=$(echo "$RESPONSE" | jq -r '.id // empty')
if [ -z "$ID" ]; then
  # Server didn't return an ID — allow by default to avoid blocking
  echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
  exit 0
fi

DEADLINE=$((SECONDS + 590))
while [ $SECONDS -lt $DEADLINE ]; do
  RESULT=$(curl -sf "$SERVER/api/permission-decision/$ID" 2>/dev/null || echo '{"status":"pending"}')
  STATUS=$(echo "$RESULT" | jq -r '.status')
  if [ "$STATUS" != "pending" ]; then
    echo "$RESULT" | jq -r '.response'
    exit 0
  fi
  sleep 1
done

echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny"}}}'
exit 0

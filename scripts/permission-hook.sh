#!/bin/bash
set -euo pipefail
SERVER="http://localhost:${CLAUDE_WEB_UI_PORT:-3001}"
INPUT=$(cat)

ID=$(echo "$INPUT" | curl -sf -X POST "$SERVER/hooks/permission-request" \
  -H 'Content-Type: application/json' -d @- | jq -r '.id')

if [ -z "$ID" ] || [ "$ID" = "null" ]; then
  echo '{"error": "Failed to register permission request"}' >&2
  exit 1
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

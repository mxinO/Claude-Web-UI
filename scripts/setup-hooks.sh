#!/bin/bash
set -euo pipefail

PORT="${1:-3001}"
SERVER="http://localhost:${PORT}"
SETTINGS="$HOME/.claude/settings.json"
HOOK_SCRIPT="$(cd "$(dirname "$0")" && pwd)/permission-hook.sh"

# Ensure settings file exists
mkdir -p "$(dirname "$SETTINGS")"
if [ ! -f "$SETTINGS" ]; then
  echo '{}' > "$SETTINGS"
fi

# Build hooks config
HOOKS=$(jq -n \
  --arg port "$PORT" \
  --arg server "$SERVER" \
  --arg hook_script "$HOOK_SCRIPT" \
  '{
    hooks: {
      SessionStart: [
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command: ("curl -sf -X POST \"" + $server + "/hooks/session-start\" -H \"Content-Type: application/json\" -d @- || true")
            }
          ]
        }
      ],
      PreToolUse: [
        {
          matcher: "",
          hooks: [
            {
              type: "http",
              url: ($server + "/hooks/pre-tool-use")
            }
          ]
        }
      ],
      PostToolUse: [
        {
          matcher: "",
          hooks: [
            {
              type: "http",
              url: ($server + "/hooks/post-tool-use")
            }
          ]
        }
      ],
      Notification: [
        {
          matcher: "",
          hooks: [
            {
              type: "http",
              url: ($server + "/hooks/notification")
            }
          ]
        }
      ],
      Stop: [
        {
          matcher: "",
          hooks: [
            {
              type: "http",
              url: ($server + "/hooks/stop")
            }
          ]
        }
      ],
      PermissionRequest: [
        {
          matcher: "",
          hooks: [
            {
              type: "command",
              command: $hook_script,
              timeout: 600
            }
          ]
        }
      ]
    }
  }')

# Merge hooks into existing settings
MERGED=$(jq --argjson hooks "$HOOKS" '. * $hooks' "$SETTINGS")
echo "$MERGED" > "$SETTINGS"

echo "Hooks configured in $SETTINGS for server $SERVER"

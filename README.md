# Claude Code Web UI

A web-based companion dashboard for [Claude Code](https://claude.ai/code). Provides a chat-style interface with diff review, streaming output, session management, and command autocomplete — accessible from any browser.

## Features

- **Chat UI** — Claude.ai-style chat with markdown rendering, user/assistant bubbles
- **Diff Review** — VS Code-style Monaco diff viewer for Edit/Write tool calls (click to expand)
- **Streaming Output** — live preview card while Claude is responding (via tmux capture)
- **Session Management** — switch between sessions, history persisted per-session alongside Claude's JSONL
- **Command Autocomplete** — type `/` for slash commands with sub-options (`/model`, `/effort`, `/permission-mode`)
- **File Explorer** — persistent sidebar with lazy directory loading, resizable width
- **File Autocomplete** — type `@` for file path suggestions resolved against Claude's CWD
- **Shell Commands** — type `!command` to run shell commands directly from the input box
- **`/btw` Support** — side questions shown as floating toast popups
- **Permission Control** — approve/deny tool calls from the browser
- **Reconnection** — survives network drops (Claude runs in tmux), summary of missed events
- **Light/Dark Theme** — toggle via sun/moon button in header
- **Status Bar** — shows model, permission mode, effort level, CWD, connection status

## How It Works

```
Browser (0.0.0.0:3001)
    |  WebSocket
    v
Node.js Server
    |  hooks via --settings
    v
Claude Code (in tmux)
```

The server manages a Claude Code process inside a tmux session. Claude Code hooks stream events (tool calls, messages, permissions) to the server via HTTP. The server stores events in a per-session SQLite database and broadcasts to the browser via WebSocket. User input goes from the browser through `tmux send-keys` to Claude.

## Prerequisites

- **Node.js** >= 18
- **tmux** installed
- **Claude Code** installed and authenticated (`claude` command works)
- **jq** (for the permission hook script)

## Quick Start

```bash
# One-liner: clone + install + build + start
git clone https://github.com/mxinO/Claude-Web-UI.git && cd Claude-Web-UI && ./start.sh

# Or with a specific working directory
./start.sh /path/to/project
```

Then open `http://<server-ip>:3001` in your browser.

The `start.sh` script auto-detects first run and handles `npm install` + build. Subsequent starts are instant.

### Other ways to start

```bash
# Using npm directly
npm start                          # default CWD
npm start /path/to/project         # specific CWD
npm run start:mock                 # mock mode (no Claude, for UI testing)
```

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | Server port |
| `HOST` | `0.0.0.0` | Server bind address |
| `CLAUDE_TMUX_SESSION` | `claude` | tmux session name |
| `CLAUDE_TMUX_PANE` | `0` | tmux pane index |
| `MAX_EVENT_AGE_DAYS` | `30` | Auto-prune events older than this |

## Usage

### Chat
Type messages in the input box. Enter sends, Shift+Enter for newline.

### Slash Commands
Type `/` to see available commands. Select one and type arguments:
- `/model opus` — switch model
- `/effort high` — set effort level
- `/plan` — toggle plan mode
- `/btw <question>` — ask a side question without interrupting
- `/compact` — compact conversation context

### Shell Commands
Type `!` followed by a command to run it directly on the server in Claude's working directory:
- `!ls` — list files
- `!git status` — check git status
- `!cat file.txt` — view file contents

Output appears as a styled card in the chat. Interactive commands (`vim`, `less`, `python`, etc.) are blocked. 30-second timeout.

### File References
Type `@` to autocomplete file paths. The sidebar file explorer (toggle with the arrow button) lets you browse directories and insert paths with the `+` button.

### Session Switching
Click the session ID in the header bar to see recent sessions. Click one to switch — Claude restarts with `--resume` in the correct working directory.

### Diff Review
Click any Edit/Write tool card in the chat to open a Monaco diff viewer. Click "View full file" to load the complete file on demand.

### Theme
Click the sun/moon icon in the header to toggle light/dark theme.

## Architecture

```
claude-web-ui/
├── server/
│   ├── index.ts          # Entry point — Express + WebSocket + tmux management
│   ├── hooks.ts          # Hook endpoint handlers + per-session DB switching
│   ├── api.ts            # Client API (sessions, events, commands, files)
│   ├── db.ts             # SQLite (better-sqlite3) — sessions, events, permissions
│   ├── websocket.ts      # WebSocket broadcast to browser
│   ├── tmux.ts           # tmux send-keys + session lifecycle
│   └── streaming.ts      # tmux capture-pane polling for live output
├── src/
│   ├── App.tsx            # Root layout — chat scroll, modals, streaming
│   ├── components/
│   │   ├── ChatMessage.tsx     # User/assistant bubbles, tool cards
│   │   ├── DetailModal.tsx     # Monaco diff viewer, bash output, markdown
│   │   ├── InputBox.tsx        # Textarea + autocomplete + file explorer
│   │   ├── Header.tsx          # Session picker, model/mode/effort badges
│   │   ├── StreamingCard.tsx   # Live output preview card
│   │   ├── BtwToast.tsx        # /btw side question popup
│   │   └── ...
│   └── hooks/
│       ├── useWebSocket.ts     # WebSocket connection + reconnection
│       └── useEventStore.ts    # Event state management + pagination
├── data/
│   └── hooks-settings.json    # Per-session hook config (not global)
└── test/
    └── server/                # 49 unit tests
```

### Per-Session Database

Each session's events are stored in `~/.claude/projects/<project>/<session-id>.webui.db` alongside Claude's JSONL transcript. When Claude deletes old sessions, the web UI database goes with it. When switching to a session without a webui.db, history is imported from the JSONL transcript.

### Hooks

Hooks are configured in a local `data/hooks-settings.json` file and passed to Claude via `--settings`. They are **not** installed globally — other Claude sessions (CLI, VS Code) are unaffected.

## Development

```bash
# Run server + Vite dev server with HMR
npm run dev

# Run tests
npm test

# Build frontend only
npm run build
```

## Security Warning

This is a **personal development tool**, not a production service. Be aware of:

- **Network exposure** — The server binds to `0.0.0.0` by default. Anyone on the same network can access the UI, send commands to Claude, and run shell commands via `!`. Set `HOST=127.0.0.1` or use a firewall to restrict access.
- **No authentication** — There is no login or auth layer. All visitors have full access.
- **Permission approval** — The permission control UI (approve/deny tool calls) works but has **not been extensively tested** across all Claude Code versions and edge cases. Treat it as a convenience, not a security boundary. When running with elevated permission modes (`auto`, `bypassPermissions`), Claude acts without asking.
- **Shell execution** — The `!command` feature runs commands directly on the host as the server's user. Interactive commands are blocked by a best-effort blocklist, and there is a 30-second timeout, but this is not a sandbox.
- **File access** — The file explorer and `@` autocomplete only block a small set of sensitive dotfiles (`.ssh`, `.gnupg`, `.aws`, `.env`). All other files readable by the server process are accessible.

## Known Limitations

- **Slash commands** — The autocomplete list is hardcoded and may not include all commands available in your Claude Code version. Commands not in the list still work when typed manually.
- **Permission hooks** — Permission approval/denial is routed through hooks. If Claude Code changes its hook format, the integration may break silently.
- **Single user** — The server manages one Claude tmux session. Multiple browser tabs work (shared WebSocket), but multiple simultaneous users may conflict.
- **Shell commands** — `!command` runs one command at a time. Interactive programs (`vim`, `less`, `python`, etc.) are blocked. Commands that spawn background children (`cmd &`) are not tracked after the parent exits. The blocklist can be bypassed via indirect invocation (e.g., `bash -c "vim"`); the 30-second timeout is the real safety net.
- **Session resume** — When switching sessions, the CWD is restored from the session database. If the original directory no longer exists, Claude starts in the server's CWD.
- **Streaming output** — Live preview is captured via `tmux capture-pane` polling. Very fast output may be partially missed in the preview (the final result is always captured by hooks).
- **Diff viewer** — Only shows diffs for Edit/Write tool calls. Multi-file edits (MultiEdit) show each file separately.

## Tech Stack

- **Server:** Node.js, Express, TypeScript, better-sqlite3, ws
- **Frontend:** React 18, TypeScript, Vite
- **Diff Viewer:** Monaco Editor (lazy-loaded)
- **Markdown:** react-markdown + rehype-highlight

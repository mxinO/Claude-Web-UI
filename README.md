# Claude Code Web UI

A web-based companion dashboard for [Claude Code](https://claude.ai/code). Provides a chat-style interface with diff review, streaming output, session management, and command autocomplete — accessible from any browser.

## Features

- **Chat UI** — Claude.ai-style chat with markdown rendering, user/assistant bubbles
- **Diff Review** — VS Code-style Monaco diff viewer for Edit/Write tool calls (click to expand)
- **Streaming Output** — live preview card while Claude is responding (via tmux capture)
- **Session Management** — switch between sessions, history persisted per-session alongside Claude's JSONL
- **Command Autocomplete** — type `/` for slash commands with sub-options (`/model`, `/effort`, `/permission-mode`)
- **File Autocomplete** — type `@` for file path suggestions, file explorer panel
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

## Install

```bash
git clone <repo-url> claude-web-ui
cd claude-web-ui
npm install
npm run build
```

## Start

```bash
# Start server + Claude Code in tmux (default CWD: current directory)
npm start

# Start with a specific working directory for Claude
npm start /path/to/project

# Start in mock mode (no tmux/Claude, for UI testing)
npm run start:mock
```

Then open `http://<server-ip>:3001` in your browser.

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

### File References
Type `@` to autocomplete file paths, or click the file explorer button next to the input.

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

## Tech Stack

- **Server:** Node.js, Express, TypeScript, better-sqlite3, ws
- **Frontend:** React 18, TypeScript, Vite
- **Diff Viewer:** Monaco Editor (lazy-loaded)
- **Markdown:** react-markdown + rehype-highlight

# Changelog

## v1.2 — 2026-04-16

### New Features
- **File/folder creation** — create new files (📄+) and folders (📁+) from the file explorer, per directory and from the root header
- **File editing** — in-browser Monaco editor with syntax highlighting, launched via ✎ button. Unsaved changes prompt confirmation on close
- **File upload/download** — upload files to any directory (↑ button), download individual files (↓ button)
- **Token authentication** — random access token generated each start, cookie-based session (httpOnly, sameSite strict, 7-day expiry). `--no-auth` to disable
- **CLI args** — `--host`, `--port`, `--no-auth` flags for `start.sh` and `npm start`
- **GFM markdown tables** — GitHub Flavored Markdown table rendering with themed styles (remark-gfm)

### Security
- `isPathSafe` now confines all file operations to Claude's working directory (prevents path traversal)
- Hook endpoints restricted to localhost only
- WebSocket auth via cookie check during upgrade handshake (close code 4401)
- Server error messages sanitized — no internal paths leaked to client
- Removed `recursive: true` from mkdir endpoint

### Fixes
- Slash command routing no longer triggers on file paths starting with `/`
- Default server bind changed from `0.0.0.0` to `localhost` (safe for SSH port forwarding)
- Circular dependency between index.ts and websocket.ts resolved (extracted auth.ts)
- Status message color uses explicit ok/error type instead of substring matching
- Editor uses `key={path}` to prevent stale content on reopen

### Docs
- README: file explorer CRUD and editor documentation
- README: updated security section for CWD-confined file access
- README: auth usage and CLI args

---

## v1.1 — 2026-04-15

### New Features
- **Sidebar file explorer** — persistent left panel with lazy directory loading, resizable width (drag to resize), open/close state saved in localStorage
- **Shell commands (`!command`)** — run shell commands directly from the input box. Output shown as styled cards in the chat. Interactive programs blocked, 30s timeout, one command at a time. Process lifecycle hardened (SIGTERM→SIGKILL escalation, client disconnect cleanup)
- **`@` file suggestions use Claude's CWD** — file autocomplete and recent files resolve against the active session's working directory, not the server's. Relative input paths produce relative output paths

### Fixes
- File explorer CWD reads from session DB instead of tmux header parsing (reliable after resume)
- Scroll to bottom on session resume with long history
- `parseInt` NaN guard for corrupted localStorage sidebar width
- Removed dead `session-changed` event listener in FileExplorer
- CWD tooltip shows full path on hover

### Docs
- README: added Security Warning and Known Limitations sections
- README: updated project description — lightweight architecture, full Claude Code compatibility, resilient reconnection

---

## v1 — 2026-04-15

Initial tagged release. Full-featured web companion for Claude Code.

### Core
- Chat UI with markdown rendering (react-markdown + rehype-highlight)
- VS Code-style Monaco diff viewer for Edit/Write tool calls
- Streaming output via tmux capture-pane polling
- Per-session SQLite database stored alongside Claude's JSONL
- WebSocket broadcast for real-time event updates

### Session Management
- Session picker in header — switch between sessions with `--resume`
- JSONL import when switching to a session without webui.db
- Per-session hooks via `--settings` (not global — other Claude sessions unaffected)
- Cross-CWD session resume with DB path lookup by session ID

### Input & Autocomplete
- `/` slash commands with sub-options (`/model`, `/effort`, `/permission-mode`)
- `@` file path autocomplete with directory browsing
- `/btw` side questions shown as floating toast popups
- Message queue with edit/cancel when Claude is busy
- Input history (arrow up/down)

### Tool Integration
- Permission control — approve/deny tool calls from the browser
- Auto-approve in bypass/auto permission modes
- Tool cards with status icons (running, success, error)
- Subagent start/stop indicators
- Task created/completed badges

### Reliability
- Reconnection with missed-event summary (edits, commands, agent activity)
- Bracketed paste for reliable tmux input (special characters, long messages)
- Curl command hooks instead of HTTP hooks (cross-version compatibility)
- Cancel button with prompt restoration and partial response preview
- Thinking indicator only for active requests (not history replay)

### UI
- Light/dark theme toggle (persisted in localStorage)
- Status bar: model, permission mode, effort level, CWD, connection status
- Auto-scroll with user-scroll-up detection
- `start.sh` one-command launcher with auto-install and build

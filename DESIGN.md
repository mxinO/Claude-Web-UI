# Design & Architecture

A guide for developers joining the project. Read this alongside the
[README](README.md) (user-facing) and [CHANGELOG](CHANGELOG.md) (what changed
when).

## 1. The core idea

There is **no AI backend**. Claude Code itself — the normal interactive CLI —
runs inside a tmux session. This server is a thin bridge:

```
 Browser  ◄──WebSocket──►  Node server  ──tmux send-keys──►  Claude Code (in tmux)
                                ▲                                    │
                                └──────── HTTP hooks ◄───────────────┘
```

- **Input** flows browser → server → `tmux send-keys` → Claude's TUI.
- **Output/events** flow Claude → Claude Code hooks (curl POSTs) → server → DB +
  WebSocket → browser.
- **Live "thinking" preview** is scraped from the tmux pane via
  `capture-pane` polling, because hooks don't fire mid-token.

Everything Claude Code can do (tools, MCP, skills, slash commands) works
unchanged, because we never reimplement Claude — we drive the real thing.

### Why tmux?

Resilience. Claude keeps running even when the browser closes or the network
drops. tmux is the durable host process; the web server and browser are both
disposable views onto it. Reconnect from any device and the server replays
what you missed.

The session runs on a **dedicated socket** (`tmux -L claude-webui`) so it's
invisible to a user's normal `tmux ls` / `tmux attach`.

## 2. Request/response lifecycle

A single user turn, end to end:

1. Browser POSTs `/api/send-input` with the message text.
2. Server writes the text into the tmux pane via a bracketed-paste buffer
   (`load-buffer` + `paste-buffer`), then schedules the `Enter` keystroke
   ~260 ms later (Claude Code debounces Enter after a paste). The HTTP response
   returns immediately after the paste — the deferred Enter is fire-and-forget
   so the UI bubble appears without waiting.
3. Claude Code's `UserPromptSubmit` hook fires → `POST /hooks/user-prompt` →
   server records a `user_message` event and starts pane-streaming.
4. As Claude works, hooks fire: `PreToolUse`, `PostToolUse`, `Stop`,
   `SubagentStart/Stop`, `Notification`, `PermissionRequest`. Each is a curl
   POST to `/hooks/*`. The server turns them into DB events and broadcasts them.
5. Between hooks, the streaming poller scrapes the pane and pushes `streaming`
   text frames for the live preview card.
6. `Stop` ends the turn; the server captures any remaining assistant text (see
   §6) and marks Claude idle, draining the input queue.

## 3. Code map

### Server (`server/`, Node + Express + better-sqlite3 + ws)

| File | Responsibility |
|---|---|
| `index.ts` | Entry point. Arg parsing, Express + WS wiring, static serving (with no-cache on `index.html`), tmux session bootstrap/launch, hook-settings generation. |
| `hooks.ts` | The `/hooks/*` endpoints Claude Code calls. Translates hook payloads into DB events + broadcasts. Also tails the JSONL transcript to recover intermediate assistant text (§6). Largest/most subtle file. |
| `api.ts` | The browser-facing REST API: sessions, events, file read/write/browse, exec (`!cmd`), slash commands, `/btw`, upload/download, interrupt. |
| `db.ts` | SQLite schema + queries. Per-session DB (§5). Event ordering by `(timestamp, id)`. |
| `tmux.ts` | All tmux interaction: `sendInput`, session start/stop/status, the validated `TMUX`/`TMUX_SESSION`/`TMUX_SOCKET` constants, and `tmuxExecOpts()` (stderr-piped exec opts). |
| `streaming.ts` | `capture-pane` polling + `parseClaudeOutput()` — the TUI scraper that produces the live preview and detects a dead session. |
| `restart.ts` | `autoRestartClaude()` — resume Claude in the same cwd if its tmux session dies. Rate-limited, with a post-restart health check. |
| `queue.ts` | Input queue: hold messages while Claude is busy, drain when idle. Tracks the `claudeBusy` flag. |
| `websocket.ts` | WS server: client subscribe + event/permission/queue broadcasts with reconnect catch-up. |
| `auth.ts` | Token cookie auth (per-hostname cookie name). |
| `types.ts` | Shared DB row types. |

### Frontend (`src/`, React 18 + Vite + TypeScript)

| File | Responsibility |
|---|---|
| `App.tsx` | Root layout, scroll management, modal/streaming/toast orchestration, custom-event wiring. |
| `hooks/useWebSocket.ts` | WS connection + reconnection, session-id polling on cold start, dispatches incoming messages. |
| `hooks/useEventStore.ts` | Event list state; **timestamp-ordered insertion** (§6), pagination. |
| `hooks/useAuthRecovery.ts` | Distinguishes network blip vs lost-auth; transparently re-issues 401'd requests. |
| `components/ChatMessage.tsx` | Renders one event (user/assistant bubble, tool card, etc.). |
| `components/InputBox.tsx` | Textarea + `/` `@` `!` autocomplete + slash/btw/shell routing. |
| `components/DetailModal.tsx` | Monaco diff viewer for Edit/Write; full-file view. |
| `components/FileExplorer.tsx` | Sidebar file tree, CRUD, Monaco editor, image/PDF viewer. |
| `components/Header.tsx` | Session picker, model/mode/effort badges, hostname, cwd. |
| `components/CwdPicker.tsx` | Working-dir picker for New Session. |
| `components/StreamingCard.tsx` / `ThinkingIndicator.tsx` | Live preview while Claude works. |
| `components/PermissionBar.tsx` / `ReconnectSummary.tsx` / `BtwToast.tsx` | Permission approve/deny, missed-events summary, `/btw` popup. |

### Scripts (`scripts/`, `start.sh`, `bin/`)

- `start.sh` — the launcher. Installs deps, builds if stale, cleans up previous
  instances (PGID kill + port fallback), launches the server with `setsid`,
  handles graceful shutdown (bounded TERM→KILL).
- `bin/claude-web-ui` — the installed CLI (npm global). Delegates to `start.sh`;
  `--update` reinstalls from the GitHub tarball.
- `scripts/permission-hook.sh` — the `PermissionRequest` hook (needs `jq`).

## 4. Hooks — how events get in

The server writes a `data/hooks-settings.json` at startup and launches Claude
with `--settings <that file>`. Hooks are **not** installed globally, so other
Claude sessions (CLI, IDE) are unaffected. Each hook is a `command`-type hook
that curls a localhost endpoint:

| Claude Code hook | Endpoint | Becomes |
|---|---|---|
| SessionStart | `/hooks/session-start` | sets managed session, switches DB |
| UserPromptSubmit | `/hooks/user-prompt` | `user_message` event, start streaming |
| PreToolUse | `/hooks/pre-tool-use` | snapshot file for diff; capture intermediate text |
| PostToolUse | `/hooks/post-tool-use` | `tool_result` event (+ diff); resume streaming |
| Stop | `/hooks/stop` | final `assistant_message`; mark idle |
| PermissionRequest | `/hooks/permission-request` | `permission_request` event + blocking prompt |
| SubagentStart/Stop | `/hooks/subagent-*` | `subagent_start` / `subagent_stop` |
| TaskCreated/Completed | `/hooks/task-*` | `task_created` / `task_completed` |
| Notification | `/hooks/notification` | `notification` (noisy ones filtered) |
| SessionEnd | `/hooks/session-end` | marks session ended |

A middleware drops events from any session other than the managed one, and
blocks all events until the first `SessionStart` arrives.

**Key constraint:** Claude Code has *no* hook that fires per assistant text
block. `Stop` only carries the final text. See §6.

## 5. Per-session database

Each session's events live in
`~/.claude/projects/<encoded-cwd>/<session-id>.webui.db`, right next to Claude's
own `<session-id>.jsonl` transcript. Consequences:

- When Claude deletes an old session, our DB goes with it. No orphan cleanup.
- Switching sessions calls `switchDb()` to repoint the connection.
- If a session has no `.webui.db` yet, history is imported from the JSONL.
- **Caution:** SQLite over NFS + mmap can SIGBUS after long idle. Known risk,
  not yet hardened.

Schema: `sessions`, `events`, `permission_requests` (see `db.ts`). Events carry
a millisecond-precision `timestamp` and are queried `ORDER BY (timestamp, id)`.

## 6. The two hard problems

These are the non-obvious parts worth understanding before editing.

### (a) Live streaming via pane scraping

Hooks don't fire mid-token, so the only way to show "Claude is typing" is to
poll `tmux capture-pane` (~400 ms) and parse the TUI text. `parseClaudeOutput()`
in `streaming.ts`:

- Anchors on the **last `●` marker** after the current `❯` user prompt — that's
  the block Claude is currently emitting.
- Falls back to surfacing the **spinner status line** (`Forming…`, `Channeling…`)
  during the pre-text "thinking" phase so the card isn't blank.
- Strips spinner glyphs, TUI tips (`⎿`), and de-indents body text.
- Detects a dead session (repeated capture failures + `has-session` check) and
  triggers auto-restart.

This is inherently fragile — it parses rendered terminal output. When Claude
Code changes its TUI, this is the first thing to break. It has unit tests
(`test/server/streaming.test.ts`) built from real captured panes; **add a case
there when you touch it.**

### (b) Capturing intermediate assistant text

A turn can be `text → tool → text → tool → text`. The `Stop` hook only gives us
the *final* text, so everything Claude said before/between tools was being lost.

Solution: every hook payload includes `transcript_path` pointing at the JSONL,
which records **one entry per part in chronological order**. On each
PreToolUse/PostToolUse/Stop, `captureIntermediateText()` tails the JSONL and
inserts any new `assistant` text entries as `assistant_message` events,
deduped by the entry `uuid`.

Because a JSONL flush can lag the hook, captured text may be **inserted after**
the `tool_result` it chronologically preceded. We don't fight the race — instead
each event is stored with the **JSONL entry's own timestamp**, and both the API
(`ORDER BY timestamp, id`) and the frontend (binary-search insertion in
`useEventStore`) sort by timestamp. Late inserts land in the right place.

**Timestamp format must match exactly** across server and client:
`YYYY-MM-DD HH:MM:SS.sss` (space separator, no `Z`). ISO format (`T`/`Z`) lex-sorts
differently and pins events to the wrong end — this has bitten us twice already
(bash output, and the initial implementation).

## 7. Resilience mechanisms

- **Reconnect catch-up:** the client tracks `last_event_id`; on WS reconnect the
  server replays missed events and sends a `ReconnectSummary`.
- **Auto-restart:** if the tmux session dies, `restart.ts` resumes Claude in the
  same cwd (`--resume` when a JSONL exists), rate-limited to once per 30 s, with
  a 5 s health check that reports a hard failure to the UI.
- **Process-group cleanup:** `start.sh` launches with `setsid` so the whole
  tsx/node tree can be reaped with `kill -- -PGID`; a `fuser` port-kill is the
  fallback for stale PID files. Shutdown is bounded (TERM, wait ≤3 s, then KILL).
- **Auth recovery:** a 401 triggers a single shared probe; if the cookie is
  still valid the original request is transparently retried, else the re-auth
  overlay appears.

## 8. Security model

This is a **personal dev tool**, not a hardened service. The boundaries:

- Token cookie auth (random per start, per-hostname cookie name). `--no-auth`
  disables. Hook endpoints are localhost-only.
- File APIs are confined to Claude's cwd via `isPathSafe`, which resolves
  **real paths** (`realpathSync`) so a symlink can't escape the cwd, and blocks
  sensitive dirs (`.ssh`, `.gnupg`, `.aws`, `.config/gcloud`, `.env`).
- `/api/file` streams bytes via `res.sendFile` (no whole-file buffering; native
  Content-Type) so images/PDFs render in-browser.
- `!command` exec runs as the server user with a 30 s timeout and an
  interactive-command blocklist — best-effort, not a sandbox.
- Slash commands are rejected while Claude is busy (they'd be misinterpreted by
  the TUI).

## 9. Local development

```bash
npm install
npm run dev        # Vite dev server (HMR) + tsx server in --mock mode
npm test           # vitest (server unit tests)
npm run build      # production frontend build → dist/client
```

`--mock` mode runs the server without tmux/Claude so you can iterate on the UI
with synthetic events. `dist/` is committed so npm-global installs don't need a
build step.

### Conventions

- Match surrounding code style; the server is plain Node ESM + TypeScript via
  `tsx` (no compile step in prod).
- When touching the TUI scraper or the JSONL capture, **add/adjust the unit
  tests** — these are the fragile seams.
- Keep timestamp formatting identical everywhere (§6b).
- Significant changes get a code review pass before commit.

## 10. Known limitations / sharp edges

- TUI scraping breaks when Claude Code changes its terminal rendering.
- The slash-command autocomplete list is hardcoded; unknown commands still work
  when typed.
- Single managed session — multiple browser tabs share it; multiple concurrent
  users will conflict.
- SQLite-over-NFS mmap SIGBUS after long idle (unhardened).
- Permission approval is routed through hooks; if the hook format changes it can
  break silently.

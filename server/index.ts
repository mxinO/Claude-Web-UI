import express from 'express';
import { createServer } from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { initDb, createSession, switchDb } from './db.js';
import { initWebSocket, broadcastEvent, broadcastPermission } from './websocket.js';
import { registerHookRoutes } from './hooks.js';
import { registerApiRoutes } from './api.js';
import { getSessionStatus, startClaudeSession, stopClaudeSession, TMUX_SESSION, TMUX_PANE } from './tmux.js';
import { setManagedSessionId, setWaitingForSessionStart, isWaitingForSessionStart } from './hooks.js';
import { addAllowedRoot } from './api.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Parse CLI args: --host, --port, --mock, and positional CWD
function parseArgs(argv: string[]) {
  let host = process.env.HOST || 'localhost';
  let port = parseInt(process.env.PORT || '3001');
  let mock = false;
  let cwd = process.cwd();
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--host' && argv[i + 1] && !argv[i + 1].startsWith('-')) { host = argv[++i]; }
    else if (argv[i] === '--port' && argv[i + 1] && !argv[i + 1].startsWith('-')) { port = parseInt(argv[++i]); }
    else if (argv[i] === '--mock') { mock = true; }
    else if (!argv[i].startsWith('-')) { cwd = argv[i]; }
  }
  return { host, port, mock, cwd };
}
const { host: HOST, port: PORT, mock: MOCK, cwd: CLAUDE_CWD } = parseArgs(process.argv);

// --- Database ---
// Start with a temporary DB; SessionStart hook will switch to the per-session DB
const tmpDbPath = path.join(__dirname, '..', 'data', 'claude-web-ui-tmp.db');
fs.mkdirSync(path.dirname(tmpDbPath), { recursive: true });
initDb(tmpDbPath);

// --- Express + WebSocket ---
const app = express();
app.use(express.json({ limit: '10mb' }));

registerHookRoutes(app, { broadcastEvent, broadcastPermission });
registerApiRoutes(app);

const clientDir = path.join(__dirname, '..', 'dist', 'client');
app.use(express.static(clientDir));
app.get('*', (_req, res) => {
  res.sendFile(path.join(clientDir, 'index.html'));
});

const server = createServer(app);
initWebSocket(server);

server.listen(PORT, HOST, () => {
  console.log(`Claude Web UI server listening on http://${HOST}:${PORT}`);

  if (MOCK) {
    console.log('Running in --mock mode (no tmux/Claude)');
    setManagedSessionId('mock-session'); // only accept mock events from the web UI
    return;
  }

  // Block all hook events until the managed Claude sends its SessionStart
  setWaitingForSessionStart(true);
  addAllowedRoot(CLAUDE_CWD);

  // --- Configure hooks ---
  try {
    setupHooks();
    console.log('Claude Code hooks configured');
  } catch (err) {
    console.error('Failed to configure hooks:', err);
    process.exit(1);
  }

  // --- Start Claude in tmux ---
  const status = getSessionStatus();
  if (status.alive) {
    console.log(`tmux session "${TMUX_SESSION}" already running — hooks won't apply until Claude is restarted`);
    // Bootstrap: the session already sent SessionStart before we existed.
    // Parse tmux pane to get model/cwd, create a synthetic session so the UI works.
    // Note: real-time hook events won't flow since this Claude wasn't started with --settings.
    bootstrapExistingSession();
  } else {
    try {
      startClaudeSession(`--settings ${HOOKS_SETTINGS_PATH}`, CLAUDE_CWD);
      console.log(`Started Claude Code in tmux session "${TMUX_SESSION}" (cwd: ${CLAUDE_CWD})`);
      // Safety: if SessionStart hook doesn't fire within 30s, unblock hooks
      setTimeout(() => {
        if (isWaitingForSessionStart()) {
          console.warn('SessionStart hook did not fire within 30s — unblocking hooks');
          setWaitingForSessionStart(false);
        }
      }, 30_000);
    } catch (err) {
      console.error('Failed to start Claude tmux session:', err);
      console.error(`You can start it manually: tmux new-session -d -s ${TMUX_SESSION} -c "${CLAUDE_CWD}" "claude"`);
    }
  }

  console.log(`\nOpen in browser: http://${HOST === '0.0.0.0' ? getLocalIP() : HOST}:${PORT}`);
});

// --- Graceful shutdown ---
function shutdown() {
  console.log('\nShutting down...');
  if (!MOCK) {
    try {
      stopClaudeSession();
      console.log('Stopped Claude tmux session');
    } catch { /* ignore */ }
  }
  server.close(() => {
    console.log('Server stopped');
    process.exit(0);
  });
  // Force exit after 5s
  setTimeout(() => process.exit(0), 5000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// --- Hook configuration ---
// Writes hooks to a LOCAL settings file (not ~/.claude/settings.json)
// so only our managed Claude subprocess uses them.
const HOOKS_SETTINGS_PATH = path.join(__dirname, '..', 'data', 'hooks-settings.json');

function setupHooks() {
  fs.mkdirSync(path.dirname(HOOKS_SETTINGS_PATH), { recursive: true });

  const serverUrl = `http://localhost:${PORT}`;
  const permissionScript = path.join(__dirname, '..', 'scripts', 'permission-hook.sh');

  try { fs.chmodSync(permissionScript, 0o755); } catch { /* ignore */ }

  // Use command-type hooks (curl) instead of http-type hooks for maximum
  // compatibility — http hooks may not work on all Claude Code versions.
  const curlHook = (endpoint: string) => [{
    matcher: '',
    hooks: [{
      type: 'command',
      command: `curl -sf -X POST "${serverUrl}/hooks/${endpoint}" -H "Content-Type: application/json" -d @- || true`,
    }],
  }];

  // Our hooks for the web UI
  const ourHooks: Record<string, unknown[]> = {
    SessionStart:      curlHook('session-start'),
    SessionEnd:        curlHook('session-end'),
    UserPromptSubmit:  curlHook('user-prompt'),
    Stop:              curlHook('stop'),
    PreToolUse:        curlHook('pre-tool-use'),
    PostToolUse:       curlHook('post-tool-use'),
    SubagentStart:     curlHook('subagent-start'),
    SubagentStop:      curlHook('subagent-stop'),
    TaskCreated:       curlHook('task-created'),
    TaskCompleted:     curlHook('task-completed'),
    Notification:      curlHook('notification'),
    PermissionRequest: [{
      matcher: '',
      hooks: [{
        type: 'command',
        command: permissionScript,
        timeout: 600,
      }],
    }],
  };

  // Read user's global hooks and merge — our hooks are appended, user hooks preserved
  const globalSettingsPath = path.join(process.env.HOME || '~', '.claude', 'settings.json');
  let userHooks: Record<string, unknown[]> = {};
  try {
    const globalSettings = JSON.parse(fs.readFileSync(globalSettingsPath, 'utf-8'));
    if (globalSettings.hooks) {
      userHooks = globalSettings.hooks;
    }
  } catch { /* no global settings */ }

  // Merge: for each event, concatenate user hooks + our hooks
  const mergedHooks: Record<string, unknown[]> = {};
  const allEvents = new Set([...Object.keys(ourHooks), ...Object.keys(userHooks)]);
  for (const event of allEvents) {
    const user = Array.isArray(userHooks[event]) ? userHooks[event] : [];
    const ours = Array.isArray(ourHooks[event]) ? ourHooks[event] : [];
    mergedHooks[event] = [...user, ...ours];
  }

  const settings = { hooks: mergedHooks };
  fs.writeFileSync(HOOKS_SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

/** When attaching to an already-running tmux Claude session, bootstrap
 *  a session record so the UI has something to display. Hooks won't fire
 *  for events that already happened. */
function bootstrapExistingSession() {
  try {
    const capture = execSync(
      `tmux capture-pane -t ${TMUX_SESSION}:${TMUX_PANE} -p -S -500 -E 15`,
      { encoding: 'utf-8', timeout: 3000 }
    );
    const modelMatch = capture.match(/(Opus|Sonnet|Haiku)\s+[\d.]+/i);
    const cwdMatch = capture.match(/│\s+(\/\S+)\s+│/);
    const model = modelMatch ? modelMatch[0] : undefined;
    const cwd = cwdMatch ? cwdMatch[1] : CLAUDE_CWD;

    // Use a synthetic session ID based on tmux session name + timestamp
    const sessionId = `webui-${TMUX_SESSION}-${Date.now()}`;

    // Switch to per-session DB if we have a CWD
    if (cwd) {
      const homeDir = process.env.HOME || '/root';
      const projectDirName = cwd.replace(/[^a-zA-Z0-9-]/g, '-');
      const sessionDbDir = path.join(homeDir, '.claude', 'projects', projectDirName);
      const sessionDbPath = path.join(sessionDbDir, `${sessionId}.webui.db`);
      try {
        fs.mkdirSync(sessionDbDir, { recursive: true });
        switchDb(sessionDbPath);
      } catch (err) {
        console.error(`[bootstrap] Failed to switch DB: ${err}`);
      }
    }

    createSession(sessionId, model, cwd);
    setManagedSessionId(sessionId);
    setWaitingForSessionStart(false);
    if (cwd) addAllowedRoot(cwd);
    console.log(`[bootstrap] Created session ${sessionId} (model: ${model}, cwd: ${cwd})`);
  } catch (err) {
    // Fall back: just unblock the gate so hooks can flow
    console.error(`[bootstrap] Failed to parse tmux pane: ${err}`);
    setWaitingForSessionStart(false);
  }
}

function getLocalIP(): string {
  try {
    const result = execSync("hostname -I 2>/dev/null | awk '{print $1}'", { encoding: 'utf-8' }).trim();
    return result || 'localhost';
  } catch {
    return 'localhost';
  }
}

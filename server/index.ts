import express from 'express';
import { createServer } from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { initDb } from './db.js';
import { initWebSocket, broadcastEvent, broadcastPermission } from './websocket.js';
import { registerHookRoutes } from './hooks.js';
import { registerApiRoutes } from './api.js';
import { getSessionStatus, startClaudeSession, stopClaudeSession } from './tmux.js';
import { setManagedSessionId, setWaitingForSessionStart } from './hooks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3001');
const HOST = process.env.HOST || '0.0.0.0';
const MOCK = process.argv.includes('--mock');
const TMUX_SESSION = process.env.CLAUDE_TMUX_SESSION || 'claude';
// Working directory for Claude — pass as argument after flags, or use CWD
const CLAUDE_CWD = process.argv.find((a, i) => i > 1 && !a.startsWith('-')) || process.cwd();

// --- Database ---
// Start with a temporary DB; SessionStart hook will switch to the per-session DB
const tmpDbPath = path.join(__dirname, '..', 'data', 'claude-web-ui-tmp.db');
import('fs').then(fs => fs.mkdirSync(path.dirname(tmpDbPath), { recursive: true }));
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
    console.log(`tmux session "${TMUX_SESSION}" already running — attaching hooks to it`);
  } else {
    try {
      startClaudeSession(`--settings ${HOOKS_SETTINGS_PATH}`, CLAUDE_CWD);
      console.log(`Started Claude Code in tmux session "${TMUX_SESSION}" (cwd: ${CLAUDE_CWD})`);
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

  const httpHook = (endpoint: string) => [{
    matcher: '',
    hooks: [{ type: 'http', url: `${serverUrl}/hooks/${endpoint}` }],
  }];

  const settings = {
    hooks: {
      SessionStart: [{
        matcher: '',
        hooks: [{
          type: 'command',
          command: `curl -sf -X POST "${serverUrl}/hooks/session-start" -H "Content-Type: application/json" -d @- || true`,
        }],
      }],
      SessionEnd:        httpHook('session-end'),
      UserPromptSubmit:  httpHook('user-prompt'),
      Stop:              httpHook('stop'),
      PreToolUse:        httpHook('pre-tool-use'),
      PostToolUse:       httpHook('post-tool-use'),
      SubagentStart:     httpHook('subagent-start'),
      SubagentStop:      httpHook('subagent-stop'),
      TaskCreated:       httpHook('task-created'),
      TaskCompleted:     httpHook('task-completed'),
      Notification:      httpHook('notification'),
      PermissionRequest: [{
        matcher: '',
        hooks: [{
          type: 'command',
          command: permissionScript,
          timeout: 600,
        }],
      }],
    },
  };

  fs.writeFileSync(HOOKS_SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

function getLocalIP(): string {
  try {
    const result = execSync("hostname -I 2>/dev/null | awk '{print $1}'", { encoding: 'utf-8' }).trim();
    return result || 'localhost';
  } catch {
    return 'localhost';
  }
}

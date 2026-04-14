import fs from 'fs';
import path from 'path';
import { Router, Express } from 'express';
import {
  listSessions,
  getEvents,
  getEvent,
  getPermissionRequest,
  resolvePermission,
  getReconnectSummary,
  getLatestSession,
  getDb,
} from './db.js';
import type { DbPermissionRequest } from './types.js';
import { execSync } from 'child_process';
import { sendInput, getSessionStatus, startClaudeSession, stopClaudeSession } from './tmux.js';
import { broadcastPermissionDecision } from './websocket.js';
import { getCachedCommands } from './commands.js';

export function registerApiRoutes(app: Express): void {
  const router = Router();

  // GET /api/sessions — list all sessions
  router.get('/sessions', (_req, res) => {
    const sessions = listSessions();
    res.json(sessions);
  });

  // GET /api/sessions/latest — get the most recent session
  router.get('/sessions/latest', (_req, res) => {
    const session = getLatestSession();
    if (!session) {
      res.status(404).json({ error: 'No sessions found' });
      return;
    }
    res.json(session);
  });

  // GET /api/events?session_id=X&before=Y&after_id=Z&limit=N — paginated events
  router.get('/events', (req, res) => {
    const { session_id, before, after_id, limit } = req.query;
    if (!session_id || typeof session_id !== 'string') {
      res.status(400).json({ error: 'session_id is required' });
      return;
    }
    const options: { before?: number; limit?: number; afterId?: number } = {};
    if (before !== undefined) options.before = parseInt(before as string, 10);
    if (after_id !== undefined) options.afterId = parseInt(after_id as string, 10);
    if (limit !== undefined) options.limit = parseInt(limit as string, 10);
    const events = getEvents(session_id, options);
    res.json(events);
  });

  // GET /api/events/:id — single event
  router.get('/events/:id', (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid event id' });
      return;
    }
    const event = getEvent(id);
    if (!event) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }
    res.json(event);
  });

  // GET /api/permission-decision/:id — poll for decision
  router.get('/permission-decision/:id', (req, res) => {
    const perm = getPermissionRequest(req.params.id);
    if (!perm) {
      res.status(404).json({ error: 'Permission request not found' });
      return;
    }
    if (perm.decision === 'pending') {
      res.json({ status: 'pending' });
      return;
    }
    res.json({ status: perm.decision, response: perm.response_json ? JSON.parse(perm.response_json) : null });
  });

  // POST /api/permission-decision/:id — submit allow/deny
  router.post('/permission-decision/:id', (req, res) => {
    const { allow } = req.body as { allow?: boolean };
    if (typeof allow !== 'boolean') {
      res.status(400).json({ error: 'allow (boolean) is required' });
      return;
    }
    const perm = getPermissionRequest(req.params.id);
    if (!perm) {
      res.status(404).json({ error: 'Permission request not found' });
      return;
    }
    const decision = allow ? 'allow' : 'deny';
    resolvePermission(req.params.id, decision);

    // Look up session_id from the event
    const event = getEvent(perm.event_id);
    if (event) {
      broadcastPermissionDecision(event.session_id, req.params.id, decision);
    }

    res.json({ ok: true, decision });
  });

  // POST /api/send-input — send text to Claude via tmux
  router.post('/send-input', (req, res) => {
    const { text } = req.body as { text?: string };
    if (typeof text !== 'string') {
      res.status(400).json({ error: 'text (string) is required' });
      return;
    }
    try {
      sendInput(text);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/send-command — send a slash command, wait, capture TUI response
  // For slash commands that don't trigger hooks (e.g. /model, /compact, /clear)
  const TMUX_SESSION = process.env.CLAUDE_TMUX_SESSION || 'claude';
  const TMUX_PANE = process.env.CLAUDE_TMUX_PANE || '0';

  router.post('/send-command', async (req, res) => {
    const { text } = req.body as { text?: string };
    if (typeof text !== 'string') {
      res.status(400).json({ error: 'text (string) is required' });
      return;
    }
    try {
      // Capture pane BEFORE sending to know what's already there
      const before = execSync(
        `tmux capture-pane -t ${TMUX_SESSION}:${TMUX_PANE} -p -S -5`,
        { encoding: 'utf-8', timeout: 3000 }
      );

      sendInput(text);

      // Wait for the command to be processed
      await new Promise(resolve => setTimeout(resolve, 1500));

      // Capture pane AFTER to find the response
      const after = execSync(
        `tmux capture-pane -t ${TMUX_SESSION}:${TMUX_PANE} -p -S -10`,
        { encoding: 'utf-8', timeout: 3000 }
      );

      // Extract the response: find lines after the command that weren't in "before"
      const response = extractCommandResponse(after, text);

      res.json({ ok: true, command: text, response });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/reconnect-summary?session_id=X&after_event_id=Y
  router.get('/reconnect-summary', (req, res) => {
    const { session_id, after_event_id } = req.query;
    if (!session_id || typeof session_id !== 'string') {
      res.status(400).json({ error: 'session_id is required' });
      return;
    }
    const afterEventId = after_event_id ? parseInt(after_event_id as string, 10) : 0;
    const summary = getReconnectSummary(session_id, afterEventId);
    res.json(summary);
  });

  // GET /api/session/status — tmux session alive check
  router.get('/session/status', (_req, res) => {
    const status = getSessionStatus();
    res.json(status);
  });

  // POST /api/session/start — start Claude in tmux
  router.post('/session/start', (req, res) => {
    const { args } = req.body as { args?: string };
    try {
      startClaudeSession(args ?? '');
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/session/stop — graceful shutdown
  router.post('/session/stop', (_req, res) => {
    try {
      stopClaudeSession();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/permission-for-event/:eventId — lookup permission_request by event_id
  router.get('/permission-for-event/:eventId', (req, res) => {
    const eventId = parseInt(req.params.eventId, 10);
    if (isNaN(eventId)) {
      res.status(400).json({ error: 'Invalid eventId' });
      return;
    }
    const perm = getDb()
      .prepare('SELECT * FROM permission_requests WHERE event_id = ?')
      .get(eventId) as DbPermissionRequest | undefined;
    if (!perm) {
      res.status(404).json({ error: 'No permission request for this event' });
      return;
    }
    res.json(perm);
  });

  // Read a file on demand (for "expand full file" in diff viewer)
  // Safety: only allow reading files within the managed session's cwd
  const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
  router.get('/file', (req, res) => {
    const filePath = req.query.path as string;
    if (!filePath) {
      res.status(400).json({ error: 'path required' });
      return;
    }
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > MAX_FILE_SIZE) {
        res.status(413).json({ error: `File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB, max 5MB)` });
        return;
      }
      const content = fs.readFileSync(filePath, 'utf-8');
      res.json({ path: filePath, content, size: stat.size });
    } catch (err) {
      res.status(404).json({ error: `Cannot read file: ${err}` });
    }
  });

  // Current model (parsed from tmux pane header)
  router.get('/current-model', (_req, res) => {
    try {
      const capture = execSync(
        `tmux capture-pane -t ${TMUX_SESSION}:${TMUX_PANE} -p -S 0 -E 3`,
        { encoding: 'utf-8', timeout: 3000 }
      );
      // Header line looks like: "Opus 4.6 (1M context) with medium effort"
      const match = capture.match(/(Opus|Sonnet|Haiku)\s+[\d.]+(\s*\([^)]+\))?/i);
      res.json({ model: match ? match[0] : null });
    } catch {
      res.json({ model: null });
    }
  });

  // Slash commands (scraped from Claude TUI on startup)
  router.get('/commands', (_req, res) => {
    res.json(getCachedCommands());
  });

  // GET /api/claude-sessions — list recent Claude Code JSONL sessions
  router.get('/claude-sessions', (_req, res) => {
    try {
      const sessions = listClaudeSessions();
      res.json(sessions);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // List directory contents (1 level) for @file autocomplete and file explorer
  router.get('/ls', (req, res) => {
    const dirPath = (req.query.path as string) || process.cwd();
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      const items = entries
        .filter(e => !e.name.startsWith('.')) // skip hidden files
        .map(e => ({
          name: e.name,
          path: path.join(dirPath, e.name),
          isDir: e.isDirectory(),
        }))
        .sort((a, b) => {
          // Directories first, then alphabetical
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      res.json({ path: dirPath, items });
    } catch (err) {
      res.status(404).json({ error: `Cannot read directory: ${err}` });
    }
  });

  // List recently modified files in workdir (for @file suggestions)
  router.get('/recent-files', (req, res) => {
    const dirPath = (req.query.path as string) || process.cwd();
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);
    try {
      const files = getRecentFiles(dirPath, limit);
      res.json({ path: dirPath, files });
    } catch (err) {
      res.status(500).json({ error: `Failed to list recent files: ${err}` });
    }
  });

  app.use('/api', router);
}

/** Extract the response to a slash command from tmux pane capture */
function extractCommandResponse(capture: string, command: string): string {
  const lines = capture.split('\n');
  // Find the line with our command (❯ /command)
  let cmdIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim().startsWith('❯') && lines[i].includes(command)) {
      cmdIdx = i;
      break;
    }
  }
  if (cmdIdx === -1) return '';

  // Collect response lines after the command until separator or next prompt
  const responseLines: string[] = [];
  for (let i = cmdIdx + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.match(/^[─━]{5,}$/)) break;
    if (trimmed.startsWith('❯')) break;
    responseLines.push(lines[i]);
  }

  // Clean up: strip ⎿ prefix (Claude's response indicator for commands)
  return responseLines
    .map(l => l.replace(/^\s*⎿\s*/, '').trimEnd())
    .join('\n')
    .trim();
}

interface ClaudeSession {
  id: string;
  date: string;
  model: string | null;
  name: string | null;
  preview: string | null;
}

/** Read recent Claude Code JSONL sessions from ~/.claude/projects/ */
function listClaudeSessions(): ClaudeSession[] {
  const homeDir = process.env.HOME || '/root';
  const projectsDir = path.join(homeDir, '.claude', 'projects');

  // Map cwd to project directory name (e.g. /home/mxin → -home-mxin)
  const cwd = process.cwd();
  const projectDirName = cwd.replace(/\//g, '-');

  // Find matching project directory
  let projectDir: string | null = null;
  try {
    const dirs = fs.readdirSync(projectsDir);
    // Prefer exact match, fall back to closest prefix
    if (dirs.includes(projectDirName)) {
      projectDir = path.join(projectsDir, projectDirName);
    } else {
      // Try to find a directory matching the cwd
      const match = dirs.find(d => d === projectDirName || cwd.startsWith(d.replace(/-/g, '/')));
      if (match) projectDir = path.join(projectsDir, match);
    }
  } catch {
    return [];
  }

  if (!projectDir) return [];

  // List all .jsonl files sorted by mtime desc, take top 20
  let jsonlFiles: Array<{ name: string; fullPath: string; mtime: Date }> = [];
  try {
    const entries = fs.readdirSync(projectDir);
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      const fullPath = path.join(projectDir, entry);
      try {
        const stat = fs.statSync(fullPath);
        jsonlFiles.push({ name: entry, fullPath, mtime: stat.mtime });
      } catch { /* skip */ }
    }
  } catch {
    return [];
  }

  jsonlFiles.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  jsonlFiles = jsonlFiles.slice(0, 20);

  const sessions: ClaudeSession[] = [];

  for (const file of jsonlFiles) {
    const sessionId = file.name.replace(/\.jsonl$/, '');
    let model: string | null = null;
    let preview: string | null = null;
    let sessionName: string | null = null;
    let lastUserText: string | null = null;

    try {
      const content = fs.readFileSync(file.fullPath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);

          // Pick up session name if present
          if (entry.sessionName && !sessionName) {
            sessionName = entry.sessionName;
          }

          // First assistant message → grab model
          if (!model && entry.type === 'assistant' && entry.message?.model) {
            model = entry.message.model;
          }

          // Track last user message for preview
          if (entry.type === 'user') {
            // Try to get text from message content
            const msg = entry.message;
            if (msg && Array.isArray(msg.content)) {
              for (const part of msg.content) {
                if (part.type === 'text' && typeof part.text === 'string') {
                  lastUserText = part.text.trim();
                }
              }
            } else if (typeof msg?.content === 'string') {
              lastUserText = msg.content.trim();
            }
          }
        } catch { /* skip bad lines */ }
      }

      if (lastUserText) {
        preview = lastUserText.slice(-80);
      }
    } catch { /* skip unreadable */ }

    sessions.push({
      id: sessionId,
      date: file.mtime.toISOString(),
      model,
      name: sessionName,
      preview,
    });
  }

  return sessions;
}

/** Scan workdir (up to 2 levels) for recently modified files, sorted by mtime desc */
function getRecentFiles(dirPath: string, limit: number): Array<{ name: string; path: string; mtime: string }> {
  const results: Array<{ name: string; path: string; mtime: Date }> = [];

  function scan(dir: string, depth: number) {
    if (depth > 2) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist' || e.name === '__pycache__') continue;
        const fullPath = path.join(dir, e.name);
        if (e.isDirectory()) {
          scan(fullPath, depth + 1);
        } else {
          try {
            const stat = fs.statSync(fullPath);
            results.push({ name: e.name, path: fullPath, mtime: stat.mtime });
          } catch { /* skip unreadable */ }
        }
      }
    } catch { /* skip unreadable dirs */ }
  }

  scan(dirPath, 0);
  results.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return results.slice(0, limit).map(r => ({
    name: r.name,
    path: r.path,
    mtime: r.mtime.toISOString(),
  }));
}

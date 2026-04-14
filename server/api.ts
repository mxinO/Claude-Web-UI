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
import { sendInput, getSessionStatus, startClaudeSession, stopClaudeSession } from './tmux.js';
import { broadcastPermissionDecision } from './websocket.js';

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

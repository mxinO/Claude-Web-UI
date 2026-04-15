import fs from 'fs';
import path from 'path';
import { Router, Express } from 'express';
import {
  listSessions,
  getSession,
  getEvents,
  getEvent,
  insertEvent,
  getPermissionRequest,
  resolvePermission,
  updateEvent,
  getReconnectSummary,
  getLatestSession,
  getDb,
} from './db.js';
import type { DbPermissionRequest } from './types.js';
import { execSync } from 'child_process';
import { sendInput, getSessionStatus, startClaudeSession, stopClaudeSession, TMUX_SESSION, TMUX_PANE } from './tmux.js';
import { broadcastPermissionDecision, broadcastEvent } from './websocket.js';
import { setManagedSessionId, setWaitingForSessionStart, getManagedSessionId, cleanUserMessage } from './hooks.js';
import { isClaudeBusy, setClaudeBusy, enqueue, getQueue, removeQueued, resetQueue } from './queue.js';
import { stopStreaming } from './streaming.js';


// Allowed root directories for file access — the CWD and $HOME.
// Store both the logical path and the real (symlink-resolved) path so
// isPathSafe matches regardless of how the path was reached.
let allowedRoots: string[] = [];

function addRoot(dir: string): void {
  const resolved = path.resolve(dir);
  if (!allowedRoots.includes(resolved)) allowedRoots.push(resolved);
  try {
    const real = fs.realpathSync(resolved);
    if (!allowedRoots.includes(real)) allowedRoots.push(real);
  } catch { /* path doesn't exist yet */ }
}

// Seed with $HOME
addRoot(process.env.HOME || '/root');

export function addAllowedRoot(dir: string): void {
  addRoot(dir);
  console.log(`[allowedRoots] added ${dir} — now: ${allowedRoots.join(', ')}`);
}

function isPathSafe(filePath: string): boolean {
  try {
    const resolved = path.resolve(filePath);
    if (filePath.includes('..')) return false;
    // Resolve symlinks to prevent symlink traversal
    let realPath: string;
    try { realPath = fs.realpathSync(resolved); } catch { realPath = resolved; }
    // Block sensitive paths
    const blocked = ['.ssh', '.gnupg', '.aws', '.config/gcloud', '.env'];
    if (blocked.some(b => realPath.includes('/' + b + '/') || realPath.endsWith('/' + b))) return false;
    // Must be under (or equal to) an allowed root (HOME or Claude's CWD).
    // Check both the real (symlink-resolved) path AND the logical path, because
    // symlinks inside a root (e.g. ~/mxin -> /lustre/...) cause the real path
    // to escape the root's real path even though logically it's underneath.
    const underRoot = (p: string) => allowedRoots.some(root => p === root || p.startsWith(root + '/'));
    if (!underRoot(realPath) && !underRoot(resolved)) {
      console.log(`[isPathSafe] DENIED real=${realPath} logical=${resolved} — roots: ${allowedRoots.join(', ')}`);
      return false;
    }
    return true;
  } catch { return false; }
}

export function registerApiRoutes(app: Express): void {
  const router = Router();

  // GET /api/sessions — list all sessions
  router.get('/sessions', (_req, res) => {
    const sessions = listSessions();
    res.json(sessions);
  });

  // GET /api/sessions/latest — get the active managed session (or most recent)
  router.get('/sessions/latest', (_req, res) => {
    // Prefer the managed session (the one we're actively tracking)
    const managedId = getManagedSessionId();
    if (managedId) {
      const managed = getSession(managedId);
      if (managed) { res.json(managed); return; }
    }
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
    // Return the response JSON for the hook script to relay to Claude
    const fallbackResponse = {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: perm.decision === 'allow' ? 'allow' : 'deny' },
      },
    };
    res.json({
      status: perm.decision,
      response: perm.response_json ? JSON.parse(perm.response_json) : fallbackResponse,
    });
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
    updateEvent(perm.event_id, { status: allow ? 'allowed' : 'denied' });

    // Look up session_id from the event
    const event = getEvent(perm.event_id);
    if (event) {
      broadcastPermissionDecision(event.session_id, req.params.id, decision);
    }

    res.json({ ok: true, decision });
  });

  // POST /api/send-input — send text to Claude via tmux (or queue if busy)
  router.post('/send-input', (req, res) => {
    const { text } = req.body as { text?: string };
    if (typeof text !== 'string') {
      res.status(400).json({ error: 'text (string) is required' });
      return;
    }
    try {
      // Verify Claude is actually running in tmux before sending
      const status = getSessionStatus();
      if (!status.alive) {
        res.status(503).json({ error: 'No tmux session — Claude is not running' });
        return;
      }

      // Slash commands always go directly (they're TUI commands, not prompts)
      if (text.startsWith('/')) {
        sendInput(text);
        res.json({ ok: true });
        return;
      }

      // If Claude is busy, queue the message
      if (isClaudeBusy()) {
        const msg = enqueue(text);
        res.json({ ok: true, queued: true, queue_id: msg.id });
        return;
      }

      // Send immediately
      sendInput(text);
      setClaudeBusy(true);
      console.log(`[send-input] sent ${text.length} chars to tmux`);

      // Create user_message event so the UI shows it right away
      const sessionId = getManagedSessionId();
      if (sessionId) {
        const eventId = insertEvent(sessionId, 'user_message', {
          message_text: text,
          status: 'completed',
        });
        const event = getEvent(eventId);
        if (event) broadcastEvent(sessionId, event);
      }

      res.json({ ok: true, queued: false });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/queue — list queued messages
  router.get('/queue', (_req, res) => {
    res.json(getQueue());
  });

  // DELETE /api/queue/:id — remove a queued message
  router.delete('/queue/:id', (req, res) => {
    const msg = removeQueued(req.params.id);
    if (!msg) { res.status(404).json({ error: 'Not found' }); return; }
    res.json({ ok: true, message: msg });
  });

  // POST /api/interrupt — send Escape to interrupt current operation
  router.post('/interrupt', async (_req, res) => {
    try {
      // Stop streaming poll first
      stopStreaming();
      // Send Escape to tmux to interrupt
      execSync(`tmux send-keys -t ${TMUX_SESSION}:${TMUX_PANE} Escape`, { encoding: 'utf-8', timeout: 3000 });
      // Timing-sensitive: 500ms gives Claude time to restore the prompt before we capture pane output.
      // Too short → we capture mid-restore; too long → unnecessary latency on cancel.
      await new Promise(resolve => setTimeout(resolve, 500));

      // Check the prompt area at the bottom of the VISIBLE pane (not scrollback).
      // No -S flag = captures only the visible area.
      // The prompt is: separator → ❯ text → separator → status bar
      let restoredText = '';
      try {
        const visible = execSync(
          `tmux capture-pane -t ${TMUX_SESSION}:${TMUX_PANE} -p`,
          { encoding: 'utf-8', timeout: 3000 }
        );
        // Get last few non-empty lines (the prompt area)
        const lines = visible.split('\n').filter(l => l.trim());
        // Look for ❯ with text in the last 4 lines only
        const promptArea = lines.slice(-4);
        for (const line of promptArea) {
          const m = line.match(/^❯\s+(.*\S)/);
          if (m) { restoredText = m[1]; break; }
        }
      } catch { /* ignore */ }

      // Clear Claude's input and remove orphaned event from DB
      if (restoredText) {
        execSync(`tmux send-keys -t ${TMUX_SESSION}:${TMUX_PANE} C-u`, { encoding: 'utf-8', timeout: 3000 });
        // Delete the orphaned user_message from the DB
        const managedId = getManagedSessionId();
        if (managedId) {
          getDb().prepare(
            `DELETE FROM events WHERE id = (
              SELECT id FROM events WHERE session_id = ? AND event_type = 'user_message' ORDER BY id DESC LIMIT 1
            )`
          ).run(managedId);
        }
      }

      // Interrupt means Claude is idle now — reset busy flag (drains queue if any)
      setClaudeBusy(false);

      res.json({ ok: true, restoredText: restoredText || null });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/send-command — send a slash command, wait, capture TUI response
  // For slash commands that don't trigger hooks (e.g. /model, /compact, /clear)
  router.post('/send-command', async (req, res) => {
    const { text } = req.body as { text?: string };
    if (typeof text !== 'string') {
      res.status(400).json({ error: 'text (string) is required' });
      return;
    }
    try {
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

  // POST /api/send-btw — send a /btw side question, poll for popup response, dismiss
  router.post('/send-btw', async (req, res) => {
    const { question } = req.body as { question?: string };
    if (typeof question !== 'string') {
      res.status(400).json({ error: 'question (string) is required' });
      return;
    }
    try {
      sendInput(`/btw ${question}`);

      // Poll for the /btw popup response.
      // The popup shows "Esc to dismiss" immediately but the content streams in.
      // Wait until the content stabilizes (stops changing between polls).
      let response = '';
      let lastCapture = '';
      let stableCount = 0;
      for (let i = 0; i < 40; i++) { // up to 20 seconds
        await new Promise(resolve => setTimeout(resolve, 500));
        try {
          const capture = execSync(
            `tmux capture-pane -t ${TMUX_SESSION}:${TMUX_PANE} -p -S -40`,
            { encoding: 'utf-8', timeout: 3000 }
          );
          if (capture.includes('Esc to dismiss')) {
            if (capture === lastCapture) {
              stableCount++;
              // Content hasn't changed for 2 consecutive polls — done streaming
              if (stableCount >= 2) {
                response = extractBtwResponse(capture);
                break;
              }
            } else {
              stableCount = 0;
            }
            lastCapture = capture;
          }
        } catch { /* tmux not ready */ }
      }

      // Dismiss the popup only if it was actually shown
      if (lastCapture.includes('Esc to dismiss')) {
        try {
          execSync(`tmux send-keys -t ${TMUX_SESSION}:${TMUX_PANE} Escape`, { encoding: 'utf-8', timeout: 3000 });
        } catch { /* ignore */ }
      }

      res.json({ ok: !!response, question, response, timedOut: !response });
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
    if (!isPathSafe(filePath)) {
      res.status(403).json({ error: 'Access denied' });
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

  // Current model, CWD, permission mode, and effort (parsed from tmux pane)
  router.get('/current-status', (_req, res) => {
    try {
      // Capture a large range — header may be scrolled far up.
      // -S -500: up to 500 lines of scrollback. The regex search is fast (< 1ms);
      // the exec overhead dominates, not the data size. This is acceptable.
      const headerCapture = execSync(
        `tmux capture-pane -t ${TMUX_SESSION}:${TMUX_PANE} -p -S -500 -E 15`,
        { encoding: 'utf-8', timeout: 3000 }
      );
      const statusCapture = execSync(
        `tmux capture-pane -t ${TMUX_SESSION}:${TMUX_PANE} -p -S -3`,
        { encoding: 'utf-8', timeout: 3000 }
      );

      // Model: "Opus 4.6" or "Sonnet 4.6 (1M context)"
      const modelMatch = headerCapture.match(/(Opus|Sonnet|Haiku)\s+[\d.]+(\s*\([^)]+\))?/i);
      // CWD: a line inside the box containing an absolute path, e.g. "│  /home/user/project  │"
      const cwdMatch = headerCapture.match(/│\s+(\/\S+)\s+│/);
      // Effort: "with high effort"
      const effortMatch = headerCapture.match(/with\s+(low|medium|high|max)\s+effort/i);
      // Permission mode from status bar: "bypass permissions on" or "plan mode on" or "default" etc.
      let permissionMode: string | null = null;
      if (statusCapture.includes('plan mode')) permissionMode = 'plan';
      else if (statusCapture.includes('bypass permissions')) permissionMode = 'bypass';
      else if (statusCapture.includes('auto-accept')) permissionMode = 'auto';
      else if (statusCapture.includes('accept edits')) permissionMode = 'acceptEdits';
      else if (statusCapture.includes('default')) permissionMode = 'default';

      res.json({
        model: modelMatch ? modelMatch[0] : null,
        cwd: cwdMatch ? cwdMatch[1] : null,
        effort: effortMatch ? effortMatch[1].toLowerCase() : null,
        permissionMode,
      });
    } catch {
      res.json({ model: null, cwd: null, effort: null, permissionMode: null });
    }
  });

  // POST /api/reset-session — reset session tracking (after /resume)
  router.post('/reset-session', (_req, res) => {
    try {
      stopStreaming();
      resetQueue();
      setManagedSessionId(null);
      setWaitingForSessionStart(true);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /api/switch-session — kill current Claude, restart with --resume in the session's CWD
  router.post('/switch-session', async (req, res) => {
    const { sessionId, cwd } = req.body as { sessionId?: string; cwd?: string };
    if (!sessionId) {
      res.status(400).json({ error: 'sessionId required' });
      return;
    }
    try {
      // Reset all transient state before killing the old session
      stopStreaming();
      resetQueue();

      // Kill current Claude
      stopClaudeSession();
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Reset managed session so hooks attach to the new one
      setManagedSessionId(null);
      setWaitingForSessionStart(true);

      // Start Claude with --resume in the session's CWD
      const targetCwd = cwd || process.cwd();
      const __dirname = path.dirname(new URL(import.meta.url).pathname);
      const hooksSettings = path.join(__dirname, '..', 'data', 'hooks-settings.json');
      console.log(`[switch-session] resuming ${sessionId} in ${targetCwd}`);
      startClaudeSession(`--settings ${hooksSettings} --resume ${sessionId}`, targetCwd);

      // Wait until Claude is ready (SessionStart hook fires and sets managedSessionId)
      // Poll for up to 20 seconds
      for (let i = 0; i < 40; i++) {
        await new Promise(resolve => setTimeout(resolve, 500));
        if (getManagedSessionId()) break;
      }

      // If SessionStart never fired, unblock hooks anyway so the UI isn't stuck
      if (!getManagedSessionId()) {
        console.warn('[switch-session] SessionStart hook did not fire within timeout — unblocking hooks');
        setWaitingForSessionStart(false);
      } else {
        console.log(`[switch-session] ready, managed=${getManagedSessionId()}`);
      }

      res.json({ ok: true, sessionId, cwd: targetCwd, ready: !!getManagedSessionId() });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /api/claude-sessions — list recent Claude Code JSONL sessions
  // Optional ?cwd= to filter to a specific project directory
  router.get('/claude-sessions', (req, res) => {
    try {
      const cwd = (req.query.cwd as string) || undefined;
      const sessions = listClaudeSessions(cwd);
      res.json(sessions);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // List directory contents (1 level) for @file autocomplete and file explorer
  router.get('/ls', (req, res) => {
    const dirPath = (req.query.path as string) || process.cwd();
    if (!isPathSafe(dirPath)) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }
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
    if (!isPathSafe(dirPath)) {
      res.status(403).json({ error: 'Access denied' });
      return;
    }
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

/** Parse the /btw popup response from tmux capture.
 *  The popup looks like:
 *    ❯ /btw question
 *      /btw question
 *        answer text
 *      ↑/↓ scroll · f to fork · Esc to dismiss
 */
function extractBtwResponse(capture: string): string {
  const lines = capture.split('\n');

  // Find the "Esc to dismiss" line (bottom of popup)
  let dismissIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes('Esc to dismiss')) {
      dismissIdx = i;
      break;
    }
  }
  if (dismissIdx === -1) return '';

  // Find the /btw command line (top of popup content)
  let btwIdx = -1;
  for (let i = dismissIdx - 1; i >= 0; i--) {
    if (lines[i].trim().startsWith('/btw ')) {
      btwIdx = i;
      break;
    }
  }
  if (btwIdx === -1) return '';

  // Everything between the /btw line and the dismiss line is the response
  const responseLines = lines.slice(btwIdx + 1, dismissIdx);

  // Clean up: strip leading whitespace (popup is indented)
  const nonEmpty = responseLines.filter(l => l.trim().length > 0);
  if (nonEmpty.length === 0) return '';

  const minIndent = Math.min(...nonEmpty.map(l => {
    const match = l.match(/^( +)/);
    return match ? match[1].length : 0;
  }));

  return responseLines
    .map(l => l.trim().length === 0 ? '' : l.slice(minIndent))
    .join('\n')
    .trim();
}

interface ClaudeSession {
  id: string;
  date: string;
  model: string | null;
  name: string | null;
  preview: string | null;
  cwd: string; // the working directory this session belongs to
}

/** Read recent Claude Code JSONL sessions from ~/.claude/projects/.
 *  If cwd is provided, only scans that project's directory (for /resume compatibility). */
function listClaudeSessions(cwd?: string): ClaudeSession[] {
  const homeDir = process.env.HOME || '/root';
  const projectsDir = path.join(homeDir, '.claude', 'projects');

  // Determine which project dirs to scan
  let dirsToScan: string[] = [];
  try {
    const allDirs = fs.readdirSync(projectsDir);
    if (cwd) {
      // Claude Code encodes CWD by replacing all non-alphanumeric chars (except hyphens) with hyphens.
      // Our webui.db uses slash-only replacement. Try both encodings.
      const slashEncoded = cwd.replace(/\//g, '-');
      const claudeEncoded = cwd.replace(/[^a-zA-Z0-9-]/g, '-');
      const matches = allDirs.filter(d => d === slashEncoded || d === claudeEncoded);
      dirsToScan = matches.length > 0 ? matches : allDirs;
    } else {
      dirsToScan = allDirs;
    }
  } catch { return []; }

  let jsonlFiles: Array<{ name: string; fullPath: string; mtime: Date; projDir: string }> = [];
  for (const projDir of dirsToScan) {
    const projPath = path.join(projectsDir, projDir);
    try {
      const stat = fs.statSync(projPath);
      if (!stat.isDirectory()) continue;
      const entries = fs.readdirSync(projPath);
      for (const entry of entries) {
        if (!entry.endsWith('.jsonl')) continue;
        const fullPath = path.join(projPath, entry);
        try {
          const fstat = fs.statSync(fullPath);
          jsonlFiles.push({ name: entry, fullPath, mtime: fstat.mtime, projDir });
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  jsonlFiles.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  jsonlFiles = jsonlFiles.slice(0, 20);

  const sessions: ClaudeSession[] = [];

  for (const file of jsonlFiles) {
    const sessionId = file.name.replace(/\.jsonl$/, '');
    let model: string | null = null;
    let preview: string | null = null;
    let sessionName: string | null = null;
    let sessionCwd: string | null = null;
    let lastUserText: string | null = null;

    try {
      const content = fs.readFileSync(file.fullPath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim());

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);

          // Pick up CWD from early entries (system or any entry with cwd)
          if (!sessionCwd && entry.cwd) {
            sessionCwd = entry.cwd;
          }

          // Pick up session name if present
          if (entry.sessionName && !sessionName) {
            sessionName = entry.sessionName;
          }

          // First assistant message → grab model
          if (!model && entry.type === 'assistant' && entry.message?.model) {
            model = entry.message.model;
          }

          // Track last user message for preview (skip system noise)
          if (entry.type === 'user') {
            const msg = entry.message;
            let text: string | null = null;
            if (msg && Array.isArray(msg.content)) {
              for (const part of msg.content) {
                if (part.type === 'text' && typeof part.text === 'string') {
                  text = part.text.trim();
                }
              }
            } else if (typeof msg?.content === 'string') {
              text = msg.content.trim();
            }
            // Clean system noise and skip if nothing left
            const cleaned = cleanUserMessage(text);
            if (cleaned && cleaned.length > 2
                && !cleaned.startsWith('<local-command')
                && !cleaned.startsWith('<command-')
                && !cleaned.includes('Bye!')
                && cleaned !== '[Task finished]') {
              lastUserText = cleaned;
            }
          }
        } catch { /* skip bad lines */ }
      }

      if (lastUserText) {
        // Intentional: show the end of the last message (where the user left off)
        preview = lastUserText.slice(-80);
      }
    } catch { /* skip unreadable */ }

    sessions.push({
      id: sessionId,
      date: file.mtime.toISOString(),
      model,
      name: sessionName,
      preview,
      cwd: sessionCwd,
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
